import type { PeerId as Libp2pPeerId } from "@libp2p/interface/peer-id";
import { logger as logFn } from "@peerbit/logger";
import {
	AcknowledgeDelivery,
	AnyWhere,
	DataMessage,
	DeliveryMode,
	Message,
	MessageHeader,
	SeekDelivery,
	SilentDelivery
} from "@peerbit/stream-interface";
import {
	DirectStream,
	DirectStreamComponents,
	DirectStreamOptions,
	PeerStreams
} from "@peerbit/stream";
import { CodeError } from "@libp2p/interface/errors";
import {
	PubSubMessage,
	Subscribe,
	PubSubData,
	toUint8Array,
	Unsubscribe,
	GetSubscribers,
	UnsubcriptionEvent,
	SubscriptionEvent,
	PubSub,
	DataEvent,
	SubscriptionData,
	PublishEvent
} from "@peerbit/pubsub-interface";
import { getPublicKeyFromPeerId, PublicSignKey } from "@peerbit/crypto";
import { CustomEvent } from "@libp2p/interface/events";
import { PubSubEvents } from "@peerbit/pubsub-interface";

export const logger = logFn({ module: "lazysub", level: "warn" });
const logError = (e?: { message: string }) => logger.error(e?.message);

export interface PeerStreamsInit {
	id: Libp2pPeerId;
	protocol: string;
}

export type DirectSubOptions = {
	aggregate: boolean; // if true, we will collect topic/subscriber info for all traffic
};

export type DirectSubComponents = DirectStreamComponents;

export type PeerId = Libp2pPeerId | PublicSignKey;

export class DirectSub extends DirectStream<PubSubEvents> implements PubSub {
	public topics: Map<string, Map<string, SubscriptionData>>; // topic -> peers --> Uint8Array subscription metadata (the latest received)
	public peerToTopic: Map<string, Set<string>>; // peer -> topics
	public topicsToPeers: Map<string, Set<string>>; // topic -> peers
	public subscriptions: Map<string, { counter: number }>; // topic -> subscription ids
	public lastSubscriptionMessages: Map<string, Map<string, DataMessage>> =
		new Map();

	constructor(components: DirectSubComponents, props?: DirectStreamOptions) {
		super(components, ["/lazysub/0.0.0"], props);
		this.subscriptions = new Map();
		this.topics = new Map();
		this.topicsToPeers = new Map();
		this.peerToTopic = new Map();
	}

	stop() {
		this.subscriptions.clear();
		this.topics.clear();
		this.peerToTopic.clear();
		this.topicsToPeers.clear();
		return super.stop();
	}

	private initializeTopic(topic: string) {
		this.topics.get(topic) || this.topics.set(topic, new Map());
		this.topicsToPeers.get(topic) || this.topicsToPeers.set(topic, new Set());
	}

	private initializePeer(publicKey: PublicSignKey) {
		this.peerToTopic.get(publicKey.hashcode()) ||
			this.peerToTopic.set(publicKey.hashcode(), new Set());
	}

	/**
	 * Subscribes to a given topic.
	 */
	async subscribe(topic: string) {
		if (!this.started) {
			throw new Error("Pubsub has not started");
		}

		const newTopicsForTopicData: string[] = [];
		const prev = this.subscriptions.get(topic);
		if (prev) {
			prev.counter += 1;
		} else {
			this.subscriptions.set(topic, {
				counter: 1
			});

			newTopicsForTopicData.push(topic);
			this.listenForSubscribers(topic);
		}

		if (newTopicsForTopicData.length > 0) {
			const message = new DataMessage({
				data: toUint8Array(
					new Subscribe({
						topics: newTopicsForTopicData
					}).bytes()
				),
				header: new MessageHeader({ mode: new SeekDelivery({ redundancy: 2 }) })
			});

			await this.publishMessage(this.publicKey, await message.sign(this.sign));
		}
	}

	/**
	 *
	 * @param topic
	 * @param force
	 * @returns true unsubscribed completely
	 */
	async unsubscribe(
		topic: string,
		options?: { force: boolean; data: Uint8Array }
	) {
		if (!this.started) {
			throw new Error("Pubsub is not started");
		}

		const subscriptions = this.subscriptions.get(topic);

		logger.debug(
			`unsubscribe from ${topic} - am subscribed with subscriptions ${subscriptions}`
		);

		if (subscriptions?.counter && subscriptions?.counter >= 0) {
			subscriptions.counter -= 1;
		}

		const peersOnTopic = this.topicsToPeers.get(topic);
		if (peersOnTopic) {
			for (const peer of peersOnTopic) {
				this.lastSubscriptionMessages.delete(peer);
			}
		}
		if (!subscriptions?.counter || options?.force) {
			await this.publishMessage(
				this.publicKey,
				await new DataMessage({
					header: new MessageHeader({
						mode: new AnyWhere(/* {
							redundancy: 2,
							to: [...this.getPeersOnTopics([topic])]
						} */)
					}),
					data: toUint8Array(new Unsubscribe({ topics: [topic] }).bytes())
				}).sign(this.sign)
			);

			this.subscriptions.delete(topic);
			this.topics.delete(topic);
			this.topicsToPeers.delete(topic);

			return true;
		}
		return false;
	}

	getSubscribers(topic: string): PublicSignKey[] | undefined {
		const remote = this.topics.get(topic.toString());

		if (!remote) {
			return undefined;
		}
		const ret: PublicSignKey[] = [];
		for (const v of remote.values()) {
			ret.push(v.publicKey);
		}
		if (this.subscriptions.get(topic)) {
			ret.push(this.publicKey);
		}
		return ret;
	}

	private listenForSubscribers(topic: string) {
		this.initializeTopic(topic);
	}

	async requestSubscribers(
		topic: string | string[],
		to?: PublicSignKey
	): Promise<void> {
		if (!this.started) {
			throw new CodeError("not started yet", "ERR_NOT_STARTED_YET");
		}

		if (topic == null) {
			throw new CodeError("topic is required", "ERR_NOT_VALID_TOPIC");
		}

		if (topic.length === 0) {
			return;
		}

		const topics = typeof topic === "string" ? [topic] : topic;
		for (const topic of topics) {
			this.listenForSubscribers(topic);
		}

		return this.publishMessage(
			this.publicKey,
			await new DataMessage({
				data: toUint8Array(new GetSubscribers({ topics }).bytes()),
				header: new MessageHeader({
					mode: new SeekDelivery({
						to: to ? [to.hashcode()] : [],
						redundancy: 2
					})
				})
			}).sign(this.sign)
		);
	}

	getPeersOnTopics(topics: string[]): Set<string> {
		const newPeers: Set<string> = new Set();
		if (topics?.length) {
			for (const topic of topics) {
				const peersOnTopic = this.topicsToPeers.get(topic.toString());
				if (peersOnTopic) {
					peersOnTopic.forEach((peer) => {
						newPeers.add(peer);
					});
				}
			}
		}
		return newPeers;
	}

	/* getStreamsWithTopics(topics: string[], otherPeers?: string[]): PeerStreams[] {
		const peers = this.getNeighboursWithTopics(topics, otherPeers);
		return [...this.peers.values()].filter((s) =>
			peers.has(s.publicKey.hashcode())
		);
	} */

	async publish(
		data: Uint8Array | undefined,
		options?: (
			| {
					topics: string[];
					to?: (string | PublicSignKey | PeerId)[];
			  }
			| {
					topics: string[];
					mode?: SilentDelivery | SeekDelivery | AcknowledgeDelivery;
			  }
		) & { client?: string }
	): Promise<Uint8Array> {
		if (!this.started) {
			throw new Error("Not started");
		}

		const topics =
			(options as { topics: string[] }).topics?.map((x) => x.toString()) || [];

		const tos =
			(options as { to: (string | PublicSignKey | PeerId)[] })?.to?.map((x) =>
				x instanceof PublicSignKey
					? x.hashcode()
					: typeof x === "string"
					? x
					: getPublicKeyFromPeerId(x).hashcode()
			) || this.getPeersOnTopics(topics);

		// Embedd topic info before the data so that peers/relays can also use topic info to route messages efficiently
		const dataMessage = data
			? new PubSubData({
					topics: topics.map((x) => x.toString()),
					data,
					strict: !!(options as { to: string[] })?.to
			  })
			: undefined;

		const bytes = dataMessage?.bytes();
		const message = await this.createMessage(bytes, { ...options, to: tos });

		if (dataMessage) {
			this.dispatchEvent(
				new CustomEvent("publish", {
					detail: new PublishEvent({
						client: options?.client,
						data: dataMessage,
						message
					})
				})
			);
		}

		// send to all the other peers
		await this.publishMessage(this.publicKey, message, undefined);

		return message.id;
	}

	private deletePeerFromTopic(topic: string, publicKeyHash: string) {
		const peers = this.topics.get(topic);
		let change: SubscriptionData | undefined = undefined;
		if (peers) {
			change = peers.get(publicKeyHash);
		}

		this.topics.get(topic)?.delete(publicKeyHash);

		this.peerToTopic.get(publicKeyHash)?.delete(topic);
		if (!this.peerToTopic.get(publicKeyHash)?.size) {
			this.peerToTopic.delete(publicKeyHash);
		}

		this.topicsToPeers.get(topic)?.delete(publicKeyHash);

		return change;
	}

	public async onPeerReachable(publicKey: PublicSignKey) {
		// Aggregate subscribers for my topics through this new peer because if we don't do this we might end up with a situtation where
		// we act as a relay and relay messages for a topic, but don't forward it to this new peer because we never learned about their subscriptions
		/* await this.requestSubscribers([...this.topics.keys()], publicKey); */

		const resp = super.onPeerReachable(publicKey);

		const stream = this.peers.get(publicKey.hashcode());
		if (stream && this.subscriptions.size > 0) {
			// is new neighbour
			// tell the peer about all topics we subscribe to
			this.publishMessage(
				this.publicKey,
				await new DataMessage({
					data: toUint8Array(
						new Subscribe({
							topics: [...this.subscriptions.keys()]
						}).bytes()
					),
					header: new MessageHeader({
						mode: new SeekDelivery({ redundancy: 2 })
					})
				}).sign(this.sign)
			),
				[stream];
		}

		return resp;
	}

	public onPeerUnreachable(publicKeyHash: string) {
		super.onPeerUnreachable(publicKeyHash);

		const peerTopics = this.peerToTopic.get(publicKeyHash);

		const changed: string[] = [];
		if (peerTopics) {
			for (const topic of peerTopics) {
				const change = this.deletePeerFromTopic(topic, publicKeyHash);
				if (change) {
					changed.push(topic);
				}
			}
		}
		this.lastSubscriptionMessages.delete(publicKeyHash);

		if (changed.length > 0) {
			this.dispatchEvent(
				new CustomEvent<UnsubcriptionEvent>("unsubscribe", {
					detail: new UnsubcriptionEvent(
						this.peerKeyHashToPublicKey.get(publicKeyHash)!,
						changed
					)
				})
			);
		}
	}

	private subscriptionMessageIsLatest(
		message: DataMessage,
		pubsubMessage: Subscribe | Unsubscribe
	) {
		const subscriber = message.header.signatures!.signatures[0].publicKey!;
		const subscriberKey = subscriber.hashcode(); // Assume first signature is the one who is signing

		for (const topic of pubsubMessage.topics) {
			const lastTimestamp = this.lastSubscriptionMessages
				.get(subscriberKey)
				?.get(topic)?.header.timetamp;
			if (lastTimestamp != null && lastTimestamp > message.header.timetamp) {
				return false; // message is old
			}
		}

		for (const topic of pubsubMessage.topics) {
			if (!this.lastSubscriptionMessages.has(subscriberKey)) {
				this.lastSubscriptionMessages.set(subscriberKey, new Map());
			}
			this.lastSubscriptionMessages.get(subscriberKey)?.set(topic, message);
		}
		return true;
	}

	private addPeersOnTopic(
		message: DataMessage<AcknowledgeDelivery | SilentDelivery | SeekDelivery>,
		topics: string[]
	) {
		const existingPeers: Set<string> = new Set(message.header.mode.to);
		const allPeersOnTopic = this.getPeersOnTopics(topics);

		for (const existing of existingPeers) {
			allPeersOnTopic.add(existing);
		}

		allPeersOnTopic.delete(this.publicKeyHash);
		message.header.mode.to = [...allPeersOnTopic];
	}

	async onDataMessage(
		from: PublicSignKey,
		stream: PeerStreams,
		message: DataMessage,
		seenBefore: number
	) {
		if (!message.data || message.data.length === 0) {
			return super.onDataMessage(from, stream, message, seenBefore);
		}

		const pubsubMessage = PubSubMessage.from(message.data);
		if (pubsubMessage instanceof PubSubData) {
			if (message.header.mode instanceof AnyWhere) {
				throw new Error("Unexpected mode for PubSubData messages");
			}

			/**
			 * See if we know more subscribers of the message topics. If so, add aditional end receivers of the message
			 */

			let isForMe: boolean;
			if (pubsubMessage.strict) {
				isForMe =
					!!pubsubMessage.topics.find((topic) =>
						this.subscriptions.has(topic)
					) && !!message.header.mode.to?.find((x) => this.publicKeyHash === x);
			} else {
				isForMe =
					!!pubsubMessage.topics.find((topic) =>
						this.subscriptions.has(topic)
					) ||
					(pubsubMessage.topics.length === 0 &&
						!!message.header.mode.to?.find((x) => this.publicKeyHash === x));
			}
			if (isForMe) {
				if ((await this.maybeVerifyMessage(message)) === false) {
					logger.warn("Recieved message that did not verify PubSubData");
					return false;
				}

				await this.acknowledgeMessage(stream, message, seenBefore);

				if (seenBefore === 0) {
					this.dispatchEvent(
						new CustomEvent("data", {
							detail: new DataEvent({
								data: pubsubMessage,
								message
							})
						})
					);
				}
			}

			if (seenBefore > 0) {
				return false;
			}

			if (message.header.mode.to) {
				message.header.mode.to = message.header.mode.to.filter(
					(x) => x !== this.publicKeyHash
				);
			}

			// Forward
			if (!pubsubMessage.strict) {
				this.addPeersOnTopic(
					message as DataMessage<
						SeekDelivery | SilentDelivery | AcknowledgeDelivery
					>,
					pubsubMessage.topics
				);
			}

			// Only relay if we got additional receivers
			// or we are NOT subscribing ourselves (if we are not subscribing ourselves we are)
			// If we are not subscribing ourselves, then we don't have enough information to "stop" message propagation here
			if (
				message.header.mode.to?.length ||
				0 > 0 ||
				!pubsubMessage.topics.find((topic) => this.topics.has(topic)) ||
				message.header.mode instanceof SeekDelivery
			) {
				// DONT await this since it might introduce a dead-lock
				this.relayMessage(from, message).catch(logError);
			}
		} else {
			if (!(await message.verify(true))) {
				logger.warn("Recieved message that did not verify Unsubscribe");
				return false;
			}

			if (message.header.signatures!.signatures.length === 0) {
				logger.warn("Recieved subscription message with no signers");
				return false;
			}

			await this.acknowledgeMessage(stream, message, seenBefore);

			if (seenBefore > 0) {
				return false;
			}

			const sender = message.header.signatures!.signatures[0].publicKey!;
			const senderKey = sender.hashcode(); // Assume first signature is the one who is signing

			if (pubsubMessage instanceof Subscribe) {
				if (pubsubMessage.topics.length === 0) {
					logger.info("Recieved subscription message with no topics");
					return false;
				}

				if (!this.subscriptionMessageIsLatest(message, pubsubMessage)) {
					logger.trace("Recieved old subscription message");
					return false;
				}

				this.initializePeer(sender);

				const changed: string[] = [];
				pubsubMessage.topics.forEach((topic) => {
					const peers = this.topics.get(topic);
					if (peers == null) {
						return;
					}

					// if no subscription data, or new subscription has data (and is newer) then overwrite it.
					// subscription where data is undefined is not intended to replace existing data
					const existingSubscription = peers.get(senderKey);

					if (
						!existingSubscription ||
						existingSubscription.timestamp < message.header.timetamp
					) {
						peers.set(
							senderKey,
							new SubscriptionData({
								timestamp: message.header.timetamp, // TODO update timestamps on all messages?
								publicKey: sender
							})
						);
						if (!existingSubscription) {
							changed.push(topic);
						}
					}

					this.topicsToPeers.get(topic)?.add(senderKey);
					this.peerToTopic.get(senderKey)?.add(topic);
				});
				if (changed.length > 0) {
					this.dispatchEvent(
						new CustomEvent<SubscriptionEvent>("subscribe", {
							detail: new SubscriptionEvent(sender, changed)
						})
					);

					// also send back a message telling the remote whether we are subsbscring
					if (message.header.mode instanceof SeekDelivery) {
						// only if Subscribe message is of 'seek' type we will respond with our subscriptions
						const mySubscriptions = changed
							.map((x) => {
								const subscription = this.subscriptions.get(x);
								return subscription ? x : undefined;
							})
							.filter((x) => !!x) as string[];

						if (mySubscriptions.length > 0) {
							const response = new DataMessage({
								data: toUint8Array(
									new Subscribe({
										topics: mySubscriptions
									}).bytes()
								),
								// needs to be Ack or Silent else we will run into a infite message loop
								header: new MessageHeader({
									mode: new AcknowledgeDelivery({
										redundancy: 2,
										to: [sender.hashcode()]
									})
								})
							});

							await this.publishMessage(
								this.publicKey,
								await response.sign(this.sign)
							);
						}
					}
				}

				// Forward
				// DONT await this since it might introduce a dead-lock
				this.relayMessage(from, message).catch(logError);
			} else if (pubsubMessage instanceof Unsubscribe) {
				if (!this.subscriptionMessageIsLatest(message, pubsubMessage)) {
					logger.trace("Recieved old subscription message");
					return false;
				}

				const changed: string[] = [];

				for (const unsubscription of pubsubMessage.topics) {
					const change = this.deletePeerFromTopic(unsubscription, senderKey);
					if (change) {
						changed.push(unsubscription);
					}
				}

				if (changed.length > 0) {
					this.dispatchEvent(
						new CustomEvent<UnsubcriptionEvent>("unsubscribe", {
							detail: new UnsubcriptionEvent(sender, changed)
						})
					);
				}

				// Forward
				if (
					message.header.mode instanceof SeekDelivery ||
					message.header.mode instanceof SilentDelivery ||
					message.header.mode instanceof AcknowledgeDelivery
				) {
					this.addPeersOnTopic(
						message as DataMessage<
							SeekDelivery | SilentDelivery | AcknowledgeDelivery
						>,
						pubsubMessage.topics
					);
				}

				// DONT await this since it might introduce a dead-lock
				this.relayMessage(from, message).catch(logError);
			} else if (pubsubMessage instanceof GetSubscribers) {
				const subscriptionsToSend: string[] = [];
				for (const topic of pubsubMessage.topics) {
					const subscription = this.subscriptions.get(topic);
					if (subscription) {
						subscriptionsToSend.push(topic);
					}
				}

				if (subscriptionsToSend.length > 0) {
					// respond
					this.publishMessage(
						this.publicKey,
						await new DataMessage({
							data: toUint8Array(
								new Subscribe({
									topics: subscriptionsToSend
								}).bytes()
							),
							header: new MessageHeader({
								mode: new SilentDelivery({
									redundancy: 2,
									to: [sender.hashcode()]
								})
							})
						}).sign(this.sign),
						[stream]
					); // send back to same stream
				}

				// Forward
				// DONT await this since it might introduce a dead-lock
				this.relayMessage(from, message).catch(logError);
			}
		}
		return true;
	}
}

export const waitForSubscribers = async (
	libp2p: { services: { pubsub: DirectSub } },
	peersToWait:
		| PeerId
		| PeerId[]
		| { peerId: Libp2pPeerId }
		| { peerId: Libp2pPeerId }[]
		| string
		| string[],
	topic: string
) => {
	const peersToWaitArr = Array.isArray(peersToWait)
		? peersToWait
		: [peersToWait];

	const peerIdsToWait: string[] = peersToWaitArr.map((peer) => {
		if (typeof peer === "string") {
			return peer;
		}
		const id: PublicSignKey | Libp2pPeerId = peer["peerId"] || peer;
		if (typeof id === "string") {
			return id;
		}
		return id instanceof PublicSignKey
			? id.hashcode()
			: getPublicKeyFromPeerId(id).hashcode();
	});

	// await libp2p.services.pubsub.requestSubscribers(topic);
	return new Promise<void>((resolve, reject) => {
		let counter = 0;
		const interval = setInterval(async () => {
			counter += 1;
			if (counter > 100) {
				clearInterval(interval);
				reject(
					new Error("Failed to find expected subscribers for topic: " + topic)
				);
			}
			try {
				const peers = await libp2p.services.pubsub.topics.get(topic);
				const hasAllPeers =
					peerIdsToWait
						.map((e) => peers && peers.has(e))
						.filter((e) => e === false).length === 0;

				// FIXME: Does not fail on timeout, not easily fixable
				if (hasAllPeers) {
					clearInterval(interval);
					resolve();
				}
			} catch (e) {
				clearInterval(interval);
				reject(e);
			}
		}, 200);
	});
};
