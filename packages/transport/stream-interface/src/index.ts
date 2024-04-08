import type { PublicSignKey } from "@peerbit/crypto";
import type { PeerId } from "@libp2p/interface";
import type { DataMessage, Message } from "./messages.js";

export interface PeerEvents {
	"peer:session": CustomEvent<PublicSignKey>;
	"peer:reachable": CustomEvent<PublicSignKey>;
	"peer:unreachable": CustomEvent<PublicSignKey>;
}

export interface MessageEvents {
	message: CustomEvent<Message>;
}
export interface StreamEvents extends PeerEvents, MessageEvents {
	data: CustomEvent<DataMessage>;
}

export * from "./messages.js";

export interface WaitForPeer {
	waitFor(
		peer: PeerId | PublicSignKey,
		options?: { signal?: AbortSignal }
	): Promise<void>;
}

export class NotStartedError extends Error {
	constructor() {
		super("Not started");
	}
}

export class DeliveryError extends Error {
}
