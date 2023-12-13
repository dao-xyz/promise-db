import {
	variant,
	vec,
	field,
	serialize,
	deserialize,
	fixedArray,
	option
} from "@dao-xyz/borsh";
import { equals } from "uint8arrays";
import { Uint8ArrayList } from "uint8arraylist";
import {
	PublicSignKey,
	SignatureWithKey,
	verify,
	randomBytes,
	sha256Base64,
	getPublicKeyFromPeerId
} from "@peerbit/crypto";

import type { PeerId } from "@libp2p/interface/peer-id";

export const ID_LENGTH = 32;

const WEEK_MS = 7 * 24 * 60 * 60 + 1000;

const SIGNATURES_SIZE_ENCODING = "u8"; // with 7 steps you know everyone in the world?, so u8 *should* suffice

/**
 * The default msgID implementation
 * Child class can override this.
 */
export const getMsgId = async (msg: Uint8ArrayList | Uint8Array) => {
	// first bytes fis discriminator,
	// next 32 bytes should be an id
	//return  Buffer.from(msg.slice(0, 33)).toString('base64');

	return sha256Base64(msg.subarray(0, 33)); // base64EncArr(msg, 0, ID_LENGTH + 1);
};

let concatBytes: (arr: Uint8Array[], totalLength: number) => Uint8Array;
if ((globalThis as any).Buffer) {
	concatBytes = (globalThis as any).Buffer.concat;
} else {
	concatBytes = (arrays, length) => {
		if (length == null) {
			let length = 0;
			for (const element of arrays) {
				length += element.length;
			}
		}
		const output = new Uint8Array(length);
		let offset = 0;
		for (const arr of arrays) {
			output.set(arr, offset);
			offset += arr.length;
		}
		return output;
	};
}

const coerceTo = (tos: (string | PublicSignKey | PeerId)[] | Set<string>) => {
	const toHashes: string[] = [];
	let i = 0;

	for (const to of tos) {
		const hash =
			to instanceof PublicSignKey
				? to.hashcode()
				: typeof to === "string"
				? to
				: getPublicKeyFromPeerId(to).hashcode();

		toHashes[i++] = hash;
	}
	return toHashes;
};

export abstract class DeliveryMode {}

/**
 * when you just want to deliver at paths, but does not expect acknowledgement
 */
@variant(0)
export class SilentDelivery extends DeliveryMode {
	@field({ type: vec("string") })
	to: string[];

	@field({ type: "u8" })
	redundancy: number;

	constructor(properties: {
		to: (string | PublicSignKey | PeerId)[] | Set<string>;
		redundancy: number;
	}) {
		super();
		this.to = coerceTo(properties.to);
		this.redundancy = properties.redundancy;
	}
}

/**
 * Deliver and expect acknowledgement
 */
@variant(1)
export class AcknowledgeDelivery extends DeliveryMode {
	@field({ type: vec("string") })
	to: string[];

	@field({ type: "u8" })
	redundancy: number;

	constructor(properties: {
		to: (string | PublicSignKey | PeerId)[] | Set<string>;
		redundancy: number;
	}) {
		super();
		this.to = coerceTo(properties.to);
		this.redundancy = properties.redundancy;
	}
}

/**
 * Deliver but with greedy fanout so that we eventually reach our target
 * Expect acknowledgement
 */
@variant(2)
export class SeekDelivery extends DeliveryMode {
	@field({ type: option(vec("string")) })
	to?: string[];

	@field({ type: "u8" })
	redundancy: number;

	constructor(properties: {
		to?: (string | PublicSignKey | PeerId)[] | Set<string>;
		redundancy: number;
	}) {
		super();
		this.to = properties.to ? coerceTo(properties.to) : undefined;
		this.redundancy = properties.redundancy;
	}
}

@variant(3)
export class TracedDelivery extends DeliveryMode {
	@field({ type: vec("string") })
	trace: string[];

	constructor(trace: string[]) {
		super();
		this.trace = trace;
	}
}

@variant(4)
export class AnyWhere extends DeliveryMode {
	constructor() {
		super();
	}
}

@variant(0)
export class Signatures {
	@field({ type: vec(SignatureWithKey, SIGNATURES_SIZE_ENCODING) })
	signatures: SignatureWithKey[];

	constructor(signatures: SignatureWithKey[] = []) {
		this.signatures = signatures;
	}

	equals(other: Signatures) {
		return (
			this.signatures.length === other.signatures.length &&
			this.signatures.every((value, i) => other.signatures[i].equals(value))
		);
	}

	get publicKeys(): PublicSignKey[] {
		return this.signatures.map((x) => x.publicKey);
	}
}

abstract class PeerInfo {}

@variant(0)
export class MultiAddrinfo extends PeerInfo {
	@field({ type: vec("string") })
	multiaddrs: string[];

	constructor(multiaddrs: string[]) {
		super();
		this.multiaddrs = multiaddrs;
	}
}

@variant(0)
export class MessageHeader<T extends DeliveryMode = DeliveryMode> {
	@field({ type: fixedArray("u8", ID_LENGTH) })
	private _id: Uint8Array;

	@field({ type: "u64" })
	private _timestamp: bigint;

	@field({ type: "u64" })
	private _expires: bigint;

	@field({ type: option(PeerInfo) })
	private _origin?: MultiAddrinfo;

	// Not signed, since we might want to modify it during transit
	@field({ type: option(DeliveryMode) })
	mode: T;

	// Not signed, since we might want to modify it during transit
	@field({ type: option(Signatures) })
	signatures: Signatures | undefined;

	constructor(properties: {
		origin?: MultiAddrinfo;
		expires?: bigint;
		id?: Uint8Array;
		mode: T;
	}) {
		this._id = properties?.id || randomBytes(ID_LENGTH);
		this._expires = properties?.expires || BigInt(+new Date() + WEEK_MS);
		this._timestamp = BigInt(+new Date());
		this.signatures = new Signatures();
		this._origin = properties?.origin;
		this.mode = properties.mode;
	}

	get id() {
		return this._id;
	}

	get expires() {
		return this._expires;
	}

	get timetamp() {
		return this._timestamp;
	}

	get origin(): MultiAddrinfo | undefined {
		return this._origin;
	}

	equals(other: MessageHeader) {
		return this._expires === other.expires && equals(this._id, other.id);
	}

	verify() {
		return this.expires >= +new Date();
	}
}

interface WithHeader {
	header: MessageHeader;
}

const sign = async <T extends WithHeader>(
	obj: T,
	signer: (bytes: Uint8Array) => Promise<SignatureWithKey>
): Promise<T> => {
	const mode = obj.header.mode;
	obj.header.mode = undefined as any;
	const signatures = obj.header.signatures;
	obj.header.signatures = undefined;
	const bytes = serialize(obj);
	// reassign properties if some other process expects them
	obj.header.signatures = signatures;
	obj.header.mode = mode;

	const signature = await signer(bytes);
	obj.header.signatures = new Signatures(
		signatures ? [...signatures.signatures, signature] : [signature]
	);
	obj.header.mode = mode;
	return obj;
};

const verifyMultiSig = async (
	message: WithHeader,
	expectSignatures: boolean
) => {
	const signatures = message.header.signatures;
	if (!signatures || signatures.signatures.length === 0) {
		return !expectSignatures;
	}
	const to = message.header.mode;
	message.header.mode = undefined as any;
	message.header.signatures = undefined;
	const bytes = serialize(message);
	message.header.mode = to;
	message.header.signatures = signatures;

	for (const signature of signatures.signatures) {
		if (!(await verify(signature, bytes))) {
			return false;
		}
	}
	return true;
};

export abstract class Message<T extends DeliveryMode = DeliveryMode> {
	static from(bytes: Uint8ArrayList) {
		if (bytes.get(0) === DATA_VARIANT) {
			// Data
			return DataMessage.from(bytes);
		} else if (bytes.get(0) === ACKNOWLEDGE_VARIANT) {
			return ACK.from(bytes);
		} else if (bytes.get(0) === HELLO_VARIANT) {
			return Hello.from(bytes);
		} else if (bytes.get(0) === GOODBYE_VARIANT) {
			return Goodbye.from(bytes);
		}
		throw new Error("Unsupported");
	}

	abstract get header(): MessageHeader<T>;

	async sign(
		signer: (bytes: Uint8Array) => Promise<SignatureWithKey>
	): Promise<this> {
		return sign(this, signer);
	}
	abstract bytes(): Uint8ArrayList | Uint8Array;
	/* abstract equals(other: Message): boolean; */
	_verified: boolean;

	async verify(expectSignatures: boolean): Promise<boolean> {
		return this._verified != null
			? this._verified
			: (this._verified =
					(await this.header.verify()) &&
					(await verifyMultiSig(this, expectSignatures)));
	}
}

// I pack data with this message
const DATA_VARIANT = 0;

@variant(DATA_VARIANT)
export class DataMessage<
	T extends SilentDelivery | SeekDelivery | AcknowledgeDelivery | AnyWhere =
		| SilentDelivery
		| SeekDelivery
		| AcknowledgeDelivery
		| AnyWhere
> extends Message<T> {
	@field({ type: MessageHeader })
	private _header: MessageHeader<T>;

	@field({ type: option(Uint8Array) })
	private _data?: Uint8Array;

	constructor(properties: { header: MessageHeader<T>; data?: Uint8Array }) {
		super();
		this._data = properties.data;
		this._header = properties.header;
	}

	get id(): Uint8Array {
		return this._header.id;
	}

	get header(): MessageHeader<T> {
		return this._header;
	}

	get data(): Uint8Array | undefined {
		return this._data;
	}

	_serialized: Uint8Array | undefined;
	get serialized(): Uint8Array | undefined {
		return this.serialized;
	}

	/** Manually ser/der for performance gains */
	bytes() {
		/* if (this._serialized) {
			return this._serialized;
		} */
		return serialize(this);
	}

	static from(bytes: Uint8ArrayList): DataMessage {
		if (bytes.get(0) !== 0) {
			throw new Error("Unsupported");
		}
		const arr = bytes.subarray();
		const ret = deserialize(arr, DataMessage);
		ret._serialized = arr;
		return ret;
	}
}

const ACKNOWLEDGE_VARIANT = 1;

@variant(ACKNOWLEDGE_VARIANT)
export class ACK extends Message {
	@field({ type: MessageHeader })
	header: MessageHeader<TracedDelivery>;

	@field({ type: fixedArray("u8", 32) })
	messageIdToAcknowledge: Uint8Array;

	@field({ type: "u8" })
	seenCounter: number; // Number of times a peer has received the messageIdToAcknowledge before

	constructor(properties: {
		messageIdToAcknowledge: Uint8Array;
		seenCounter: number;
		header: MessageHeader<TracedDelivery>;
	}) {
		super();
		this.header = properties.header;
		this.messageIdToAcknowledge = properties.messageIdToAcknowledge;
		this.seenCounter = Math.min(255, properties.seenCounter);
	}

	get id() {
		return this.header.id;
	}

	bytes() {
		return serialize(this);
	}

	static from(bytes: Uint8ArrayList): ACK {
		const result = deserialize(bytes.subarray(), ACK);
		if (
			!result.header.signatures ||
			result.header.signatures.signatures.length === 0
		) {
			throw new Error("Missing sender on ACK");
		}
		return result;
	}
}

const HELLO_VARIANT = 2;

@variant(HELLO_VARIANT)
export class Hello extends Message {
	@field({ type: MessageHeader })
	header: MessageHeader;

	@field({ type: vec("string") })
	joined: string[];

	constructor(properties: { joined: string[] }) {
		super();
		this.joined = properties.joined;
	}

	get id() {
		return this.header.id;
	}

	bytes() {
		return serialize(this);
	}

	static from(bytes: Uint8ArrayList): Hello {
		const result = deserialize(bytes.subarray(), Hello);
		if (
			!result.header.signatures ||
			result.header.signatures.signatures.length === 0
		) {
			throw new Error("Missing sender on Hello");
		}
		return result;
	}
}

const GOODBYE_VARIANT = 3;

@variant(GOODBYE_VARIANT)
export class Goodbye extends Message {
	@field({ type: MessageHeader })
	header: MessageHeader<SilentDelivery>;

	@field({ type: vec("string") })
	leaving: string[];

	constructor(properties: {
		leaving: string[];
		header: MessageHeader<SilentDelivery>;
	}) {
		super();
		this.header = properties.header;
		this.leaving = properties.leaving;
	}
	get id() {
		return this.header.id;
	}

	bytes() {
		return serialize(this);
	}

	static from(bytes: Uint8ArrayList): Goodbye {
		const result = deserialize(bytes.subarray(), Goodbye);
		if (
			!result.header.signatures ||
			result.header.signatures.signatures.length === 0
		) {
			throw new Error("Missing sender on Goodbye");
		}
		return result;
	}
}
