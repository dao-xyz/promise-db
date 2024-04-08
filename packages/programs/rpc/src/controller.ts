import {
	type AbstractType,
	BorshError,
	deserialize,
	serialize,
	variant
} from "@dao-xyz/borsh";
import {
	DecryptedThing,
	MaybeEncrypted,
	PublicSignKey,
	toBase64,
	AccessError,
	X25519PublicKey,
	X25519Keypair,
	randomBytes
} from "@peerbit/crypto";
import { RequestV0, ResponseV0, RPCMessage } from "./encoding.js";
import {
	logger,
	type RPCResponse,
	type EncryptionOptions,
	type RPCRequestOptions
} from "./io.js";
import {
	DataEvent,
	type PublishOptions as PubSubPublishOptions
} from "@peerbit/pubsub-interface";
import { Program } from "@peerbit/program";
import {
	DataMessage,
	type PriorityOptions,
	SilentDelivery,
	type WithMode,
	deliveryModeHasReceiver
} from "@peerbit/stream-interface";
import pDefer, { type DeferredPromise } from "p-defer";
import { AbortError, TimeoutError } from "@peerbit/time";

export type RPCSetupOptions<Q, R> = {
	topic: string;
	queryType: AbstractType<Q>;
	responseType: AbstractType<R>;
	responseHandler?: ResponseHandler<Q, R>;
};
export type RequestContext = {
	from?: PublicSignKey;
	timestamp: bigint;
};
export type ResponseHandler<Q, R> = (
	query: Q,
	context: RequestContext
) => Promise<R | undefined> | R | undefined;

const createValueResolver = <T>(
	type: AbstractType<T> | Uint8Array
): ((decryptedThings: DecryptedThing<T>) => T) => {
	if ((type as any) === Uint8Array) {
		return (decrypted) => decrypted._data as T;
	} else {
		return (decrypted) => decrypted.getValue(type as AbstractType<T>);
	}
};

@variant("rpc")
export class RPC<Q, R> extends Program<RPCSetupOptions<Q, R>> {
	private _subscribed = false;
	private _responseHandler?: ResponseHandler<Q, (R | undefined) | R>;
	private _responseResolver!: Map<
		string,
		(properties: { response: ResponseV0; message: DataMessage }) => any
	>;
	private _requestType!: AbstractType<Q> | Uint8ArrayConstructor;
	private _requestTypeIsUint8Array!: boolean;
	private _responseType!: AbstractType<R>;
	private _rpcTopic!: string;
	private _onMessageBinded: ((arg: any) => any) | undefined = undefined;
	private _keypair!: X25519Keypair;
	private _getResponseValueFn!: (decrypted: DecryptedThing<R>) => R;
	private _getRequestValueFn!: (decrypted: DecryptedThing<Q>) => Q;

	async open(args: RPCSetupOptions<Q, R>): Promise<void> {
		this._rpcTopic = args.topic ?? this._rpcTopic;
		this._responseHandler = args.responseHandler;
		this._requestType = args.queryType;
		this._requestTypeIsUint8Array = (this._requestType as any) === Uint8Array;
		this._responseType = args.responseType;
		this._responseResolver = new Map();
		this._getResponseValueFn = createValueResolver(this._responseType);
		this._getRequestValueFn = createValueResolver(this._requestType);

		this._keypair = await X25519Keypair.create();
		await this.subscribe();
	}

	private async _close(from?: Program): Promise<void> {
		if (this._subscribed) {
			await this.node.services.pubsub.unsubscribe(this.topic);
			await this.node.services.pubsub.removeEventListener(
				"data",
				this._onMessageBinded
			);
			this._subscribed = false;
		}
	}
	public async close(from?: Program): Promise<boolean> {
		const superClosed = await super.close(from);
		if (!superClosed) {
			return false;
		}
		await this._close(from);
		return true;
	}

	public async drop(from?: Program): Promise<boolean> {
		const superDropped = await super.drop(from);
		if (!superDropped) {
			return false;
		}
		await this._close(from);
		return true;
	}

	private _subscribing: Promise<void> | void | undefined;
	async subscribe(): Promise<void> {
		await this._subscribing;
		if (this._subscribed) {
			return;
		}

		this._subscribed = true;

		this._onMessageBinded = this._onMessageBinded || this._onMessage.bind(this);

		this.node.services.pubsub.addEventListener("data", this._onMessageBinded!);

		this._subscribing = this.node.services.pubsub.subscribe(this.topic);

		await this._subscribing;
		logger.debug("subscribing to query topic (responses): " + this.topic);
	}

	private async _onMessage(evt: CustomEvent<DataEvent>): Promise<void> {
		const { data, message } = evt.detail;

		if (data?.topics.find((x) => x === this.topic) != null) {
			try {
				const rpcMessage = deserialize(data.data, RPCMessage);
				if (rpcMessage instanceof RequestV0) {
					if (this._responseHandler) {
						const maybeEncrypted = rpcMessage.request;
						const decrypted = await maybeEncrypted.decrypt(
							this.node.services.keychain
						);
						const response = await this._responseHandler(
							this._getRequestValueFn(decrypted),
							{
								from: message.header.signatures!.publicKeys[0],
								timestamp: message.header.timestamp
							}
						);
						if (response && rpcMessage.respondTo) {
							// send query and wait for replies in a generator like behaviour
							const serializedResponse = serialize(response);

							// we use the peerId/libp2p identity for signatures, since we want to be able to send a message
							// with pubsub with a certain receiver. If we use (this.identity) we are going to use an identity
							// that is now known in the .pubsub network, hence the message might not be delivired if we
							// send with { to: [RECIEVER] } param

							const decryptedMessage = new DecryptedThing<Uint8Array>({
								data: serializedResponse
							});
							let maybeEncryptedMessage: MaybeEncrypted<Uint8Array> =
								decryptedMessage;

							maybeEncryptedMessage = await decryptedMessage.encrypt(
								this._keypair,
								[rpcMessage.respondTo]
							);

							await this.node.services.pubsub.publish(
								serialize(
									new ResponseV0({
										response: maybeEncryptedMessage,
										requestId: message.id
									})
								),
								{
									topics: [this.topic],
									priority: message.header.priority, // send back with same priority. TODO, make this better in the future

									/// TODO make redundancy parameter configurable?
									mode: new SilentDelivery({
										to: [message.header.signatures!.publicKeys[0]],
										redundancy: 1
									})
								}
							);
						}
					}
				} else if (rpcMessage instanceof ResponseV0) {
					const id = toBase64(rpcMessage.requestId);
					const handler = this._responseResolver.get(id);
					// TODO evaluate when and how handler can be missing
					handler?.({
						message,
						response: rpcMessage
					});
				}
			} catch (error: any) {
				if (error instanceof AccessError) {
					logger.debug("Got message I could not decrypt");
					return;
				}

				if (error instanceof BorshError) {
					logger.error("Got message for a different namespace");
					return;
				}

				logger.error(
					"Error handling query: " +
					(error?.message ? error?.message?.toString() : error)
				);
			}
		}
	}

	private async seal(
		request: Q,
		respondTo?: X25519PublicKey,
		options?: EncryptionOptions
	) {
		const requestData = this._requestTypeIsUint8Array
			? (request as Uint8Array)
			: serialize(request);

		const decryptedMessage = new DecryptedThing<Uint8Array>({
			data: requestData
		});

		let maybeEncryptedMessage: MaybeEncrypted<Uint8Array> = decryptedMessage;

		if (
			options?.encryption?.responders &&
			options?.encryption?.responders.length > 0
		) {
			maybeEncryptedMessage = await decryptedMessage.encrypt(
				options.encryption.key,
				options.encryption.responders
			);
		}

		const requestMessage = new RequestV0({
			request: maybeEncryptedMessage,
			respondTo
		});

		return requestMessage;
	}

	private getPublishOptions(
		id?: Uint8Array,
		options?: EncryptionOptions & WithMode & PriorityOptions
	): PubSubPublishOptions {
		return {
			id,
			priority: options?.priority,
			mode: options?.mode,
			topics: [this.topic]
		};
	}

	/**
	 * Send message and don't expect any response
	 * @param message
	 * @param options
	 */
	public async send(
		message: Q,
		options?: EncryptionOptions & WithMode & PriorityOptions
	): Promise<void> {
		await this.node.services.pubsub.publish(
			serialize(await this.seal(message, undefined, options)),
			this.getPublishOptions(undefined, options)
		);
	}

	private createResponseHandler(
		promise: DeferredPromise<any>,
		keypair: X25519Keypair,
		allResults: RPCResponse<R>[],
		responders: Set<string>,
		expectedResponders?: Set<string>,
		options?: RPCRequestOptions<R>
	) {
		return async (properties: {
			response: ResponseV0;
			message: DataMessage;
		}) => {
			try {
				const { response, message } = properties;
				const from = message.header.signatures!.publicKeys[0];

				if (options?.isTrusted && !(await options?.isTrusted(from))) {
					return;
				}

				const maybeEncrypted = response.response;
				const decrypted = await maybeEncrypted.decrypt(keypair);
				const resultData = this._getResponseValueFn(decrypted);

				if (expectedResponders) {
					if (from && expectedResponders?.has(from.hashcode())) {
						options?.onResponse && options?.onResponse(resultData, from);
						allResults.push({ response: resultData, from });
						responders.add(from.hashcode());
						if (responders.size === expectedResponders.size) {
							promise.resolve();
						}
					}
				} else {
					options?.onResponse && options?.onResponse(resultData, from);
					allResults.push({ response: resultData, from });
					if (
						options?.amount != null &&
						allResults.length >= (options?.amount as number)
					) {
						promise.resolve();
					}
				}
			} catch (error) {
				if (error instanceof AccessError) {
					return; // Ignore things we can not open
				}

				if (error instanceof BorshError) {
					logger.debug("Namespace error");
					return; // Name space conflict most likely
				}

				console.error("failed ot deserialize query response", error);
				promise.reject(error);
			}
		};
	}

	/**
	 * Send a request and expect a response
	 * @param request
	 * @param options
	 * @returns
	 */
	public async request(
		request: Q,
		options?: RPCRequestOptions<R>
	): Promise<RPCResponse<R>[]> {
		// We are generatinga new encryption keypair for each send, so we now that when we get the responses, they are encrypted specifcally for me, and for this request
		// this allows us to easily disregard a bunch of message just beacuse they are for a different receiver!
		const keypair = await X25519Keypair.create();

		const requestMessage = await this.seal(request, keypair.publicKey, options);
		const requestBytes = serialize(requestMessage);

		const allResults: RPCResponse<R>[] = [];

		const deferredPromise = pDefer();

		if (this.closed) {
			throw new AbortError("Closed");
		}
		const timeoutFn = setTimeout(
			() => {
				deferredPromise.resolve();
			},
			options?.timeout || 10 * 1000
		);

		const abortListener = (err: Event) => {
			deferredPromise.reject((err.target as any)?.["reason"] || new AbortError());
		};
		options?.signal?.addEventListener("abort", abortListener);

		const closeListener = () => {
			deferredPromise.reject(new AbortError("Closed"));
		};
		const dropListener = () => {
			deferredPromise.reject(new AbortError("Dropped"));
		};

		this.events.addEventListener("close", closeListener);
		this.events.addEventListener("drop", dropListener);

		const expectedResponders =
			options?.mode && deliveryModeHasReceiver(options.mode)
				? new Set(options.mode.to)
				: undefined;

		const responders = new Set<string>();

		const messageId = randomBytes(32);
		const id = toBase64(messageId);
		this._responseResolver.set(
			id,
			this.createResponseHandler(
				deferredPromise,
				keypair,
				allResults,
				responders,
				expectedResponders,
				options
			)
		);

		try {
			await this.node.services.pubsub.publish(
				requestBytes,
				this.getPublishOptions(messageId, options)
			);
			await deferredPromise.promise;
		} catch (error: any) {
			if (error instanceof TimeoutError === false) {
				throw error;
			}
			// Ignore timeout errors only
		} finally {
			clearTimeout(timeoutFn);
			this.events.removeEventListener("close", closeListener);
			this.events.removeEventListener("drop", dropListener);
			options?.signal?.removeEventListener("abort", abortListener);
			this._responseResolver.delete(id);
		}

		return allResults;
	}

	public get topic(): string {
		if (!this._rpcTopic) {
			throw new Error("Not initialized");
		}
		return this._rpcTopic;
	}

	getTopics(): string[] {
		return [this.topic];
	}
}
