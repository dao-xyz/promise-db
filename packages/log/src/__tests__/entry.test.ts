import assert from "assert";
import { Entry, Payload } from "../entry.js";
import { deserialize, serialize } from "@dao-xyz/borsh";
import { Ed25519PublicKey, X25519Keypair } from "@peerbit/crypto";
import sodium from "libsodium-wrappers";
import { LamportClock, Timestamp } from "../clock.js";
import { BlockStore, MemoryLevelBlockStore } from "@peerbit/blocks";

import { sha256Base64Sync } from "@peerbit/crypto";
import { signKey } from "./fixtures/privateKey.js";
import { JSON_ENCODING } from "./utils/encoding.js";

describe("entry", function () {
	let store: BlockStore;

	beforeAll(async () => {
		await sodium.ready;
		store = new MemoryLevelBlockStore();
		await store.start();
	});

	afterAll(async () => {
		await store.stop();
	});
	describe("endocing", () => {
		it("can serialize and deserialialize", async () => {
			const entry = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
				},
				data: new Uint8Array([1]),
			});
			deserialize(serialize(entry), Entry);
		});
	});

	describe("create", () => {
		it("creates a an empty entry", async () => {
			const clock = new LamportClock({
				id: new Uint8Array([1, 2, 3]),
				timestamp: new Timestamp({ wallTime: 2n, logical: 3 }),
			});

			const entry = await Entry.create({
				store,
				identity: signKey,

				data: new Uint8Array([1]),
				meta: {
					gidSeed: Buffer.from("a"),
					clock,
				},
			});
			expect(entry.hash).toMatchSnapshot();
			expect(entry.gid).toEqual(sha256Base64Sync(Buffer.from("a")));
			expect(entry.meta.clock.equals(clock)).toBeTrue();
			expect(entry.payload.getValue()).toEqual(new Uint8Array([1]));
			expect(entry.next.length).toEqual(0);
		});

		it("creates a entry with payload", async () => {
			const payload = new Uint8Array([1]);
			const clock = new LamportClock({
				id: new Uint8Array([1, 2, 3]),
				timestamp: new Timestamp({ wallTime: 2n, logical: 3 }),
			});
			const entry = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
					clock,
				},
				data: payload,
				next: [],
				encoding: JSON_ENCODING,
			});
			expect(entry.hash).toMatchSnapshot();
			expect(entry.payload.getValue()).toEqual(payload);
			expect(entry.gid).toEqual(sha256Base64Sync(Buffer.from("a")));
			expect(entry.meta.clock.equals(clock)).toBeTrue();
			expect(entry.next.length).toEqual(0);
		});

		it("creates a encrypted entry with payload", async () => {
			const payload = new Uint8Array([1]);
			const senderKey = await X25519Keypair.create();
			const receiverKey = await X25519Keypair.create();
			const entry = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
				},
				data: payload,
				next: [],
				encryption: {
					reciever: {
						meta: undefined,
						signatures: undefined,
						payload: receiverKey.publicKey,
					},
					keypair: senderKey,
				},
			});
			assert(entry.payload instanceof Payload);
			expect(entry.payload.getValue()).toEqual(payload);

			// We can not have a hash check because nonce of encryption will always change
			expect(entry.gid).toEqual(sha256Base64Sync(Buffer.from("a")));
			expect(entry.meta.clock.id).toEqual(
				new Ed25519PublicKey({
					publicKey: signKey.publicKey.publicKey,
				}).bytes
			);
			expect(entry.meta.clock.timestamp.logical).toEqual(0);
			expect(entry.next.length).toEqual(0);
		});

		it("creates a entry with payload and next", async () => {
			const payload1 = new Uint8Array([1]);
			const payload2 = new Uint8Array([2]);
			const entry1 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
					clock: new LamportClock({
						id: new Uint8Array([0]),
						timestamp: new Timestamp({ wallTime: 0n, logical: 0 }),
					}),
				},
				data: payload1,
				next: [],
			});
			const entry2 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
					clock: new LamportClock({
						id: new Uint8Array([0]),
						timestamp: new Timestamp({ wallTime: 1n, logical: 0 }),
					}),
				},
				data: payload2,
				next: [entry1],
			});
			expect(entry2.payload.getValue()).toEqual(payload2);
			expect(entry2.next.length).toEqual(1);
			expect(entry2.hash).toMatchSnapshot();
		});

		it("`next` parameter can be an array of strings", async () => {
			const entry1 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
				},
				data: new Uint8Array([1]),
				next: [],
			});
			const entry2 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
				},
				data: new Uint8Array([2]),
				next: [entry1],
			});
			assert.strictEqual(typeof entry2.next[0] === "string", true);
		});

		it("`next` parameter can be an array of Entry instances", async () => {
			const entry1 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
				},
				data: new Uint8Array([1]),
				next: [],
			});
			const entry2 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
				},
				data: new Uint8Array([2]),
				next: [entry1],
			});
			assert.strictEqual(typeof entry2.next[0] === "string", true);
		});

		it("can calculate join gid from `next` max chain length", async () => {
			const entry0A = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
				},
				data: new Uint8Array([1]),
				next: [],
			});

			const entry1A = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
				},
				data: new Uint8Array([1]),
				next: [entry0A],
			});

			const entry1B = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("b"),
					clock: entry1A.meta.clock,
				},

				data: new Uint8Array([1]),
				next: [],
			});

			expect(entry1A.gid > entry1B.gid); // so that gid is not choosen because A has smaller gid
			expect(entry1A.meta.clock.timestamp.logical).toEqual(
				entry1B.meta.clock.timestamp.logical
			);

			const entry2 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("Should not be used"),
				},
				data: new Uint8Array([2]),
				next: [entry1A, entry1B],
			});
			expect(entry2.gid).toEqual(
				entry1A.gid < entry1B.gid ? entry1A.gid : entry1B.gid
			);
		});

		it("can calculate join gid from `next` max clock", async () => {
			const entry1A = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("b"),
				},
				data: new Uint8Array([1]),
				next: [],
			});

			const entry1B = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
					clock: entry1A.meta.clock.advance(),
				},

				data: new Uint8Array([1]),
				next: [],
			});

			expect(entry1B.gid > entry1A.gid); // so that gid is not choosen because B has smaller gid
			expect(
				entry1B.meta.clock.timestamp.compare(entry1A.meta.clock.timestamp)
			).toBeGreaterThan(0);

			const entry2 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("Should not be used"),
				},
				data: new Uint8Array([2]),
				next: [entry1A, entry1B],
			});
			expect(entry2.gid).toEqual(
				entry1A.gid < entry1B.gid ? entry1A.gid : entry1B.gid
			);
		});

		it("can calculate join gid from `next` gid comparison", async () => {
			const entry1A = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
				},
				data: new Uint8Array([1]),
				next: [],
			});

			const entry1B = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("b"),
					clock: entry1A.meta.clock,
				},

				data: new Uint8Array([1]),
				next: [],
			});

			expect(entry1B.gid < entry1A.gid).toBeTrue(); // so that B is choosen because of gid
			expect(entry1A.meta.clock.timestamp.logical).toEqual(
				entry1B.meta.clock.timestamp.logical
			);

			const entry2 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("Should not be used"),
				},
				data: new Uint8Array([2]),
				next: [entry1A, entry1B],
			});
			expect(entry2.gid).toEqual(
				entry1A.gid < entry1B.gid ? entry1A.gid : entry1B.gid
			);
		});

		it("can calculate reuse gid from `next`", async () => {
			const entry1A = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
				},
				data: new Uint8Array([1]),
				next: [],
			});

			const entry1B = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gid: entry1A.gid,
				},
				data: new Uint8Array([1]),
				next: [],
			});

			const entry2 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("Should not be used"),
				},
				data: new Uint8Array([2]),
				next: [entry1A, entry1B],
			});
			expect(entry2.gid).toEqual(entry1A.gid);
			expect(entry1A.gid).toEqual(entry1B.gid);
		});

		it("will use next for gid instaed of gidSeed", async () => {
			const entry1 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
				},
				data: new Uint8Array([1]),
				next: [],
			});

			const entry2 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("Should not be used"),
				},
				data: new Uint8Array([2]),
				next: [entry1],
			});
			expect(entry2.gid).toEqual(entry1.gid);
		});

		it("throws an error if data is not defined", async () => {
			let err: any;
			try {
				await Entry.create({
					store,
					identity: signKey,
					meta: {
						gidSeed: Buffer.from("a"),
					},
					data: null,
					next: [],
				});
			} catch (e: any) {
				err = e;
			}
			expect(err.message).toEqual("Entry requires data");
		});

		it("throws an error if next is not an array", async () => {
			let err: any;
			try {
				await Entry.create({
					store,
					identity: signKey,
					meta: {
						gidSeed: Buffer.from("a"),
					},
					data: new Uint8Array([1]),
					next: {} as any,
				});
			} catch (e: any) {
				err = e;
			}
			expect(err.message).toEqual("'next' argument is not an array");
		});
	});

	describe("toMultihash", () => {
		it("returns an ipfs multihash", async () => {
			const entry = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
					clock: new LamportClock({
						id: new Uint8Array([1, 2, 3]),
						timestamp: new Timestamp({ wallTime: 2n, logical: 3 }),
					}),
				},
				data: new Uint8Array([1]),
				next: [],
			});
			const hash = entry.hash;
			entry.hash = undefined as any;
			const multihash = await Entry.toMultihash(store, entry);
			expect(multihash).toEqual(hash);
			expect(multihash).toMatchSnapshot();
		});

		/*  TODO what is the point of this test?
    
	it('throws an error if the object being passed is invalid', async () => {
	  let err
	  try {
		const entry = await Entry.create({ store, identity: signKey, gidSeed:   'A', data: 'hello', next: [] })
		delete ((entry.metadata as MetadataSecure)._metadata as DecryptedThing<Metadata>)
		await Entry.toMultihash(store, entry)
	  } catch (e: any) {
		err = e
	  }
	  expect(err.message).toEqual('Invalid object format, cannot generate entry hash')
	}) */
	});

	describe("fromMultihash", () => {
		it("creates a entry from hash", async () => {
			const payload1 = new Uint8Array([1]);
			const payload2 = new Uint8Array([2]);
			const entry1 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
					clock: new LamportClock({
						id: new Uint8Array([1, 2, 3]),
						timestamp: new Timestamp({ wallTime: 2n, logical: 3 }),
					}),
				},
				data: payload1,
				next: [],
			});
			const entry2 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
					clock: new LamportClock({
						id: new Uint8Array([1, 2, 3]),
						timestamp: new Timestamp({ wallTime: 3n, logical: 3 }),
					}),
				},
				data: payload2,
				next: [entry1],
			});
			const final = await Entry.fromMultihash<Uint8Array>(store, entry2.hash);
			final.init(entry2);
			assert(final.equals(entry2));
			expect(final.gid).toEqual(sha256Base64Sync(Buffer.from("a")));
			expect(final.payload.getValue()).toEqual(payload2);
			expect(final.next.length).toEqual(1);
			expect(final.next[0]).toEqual(entry1.hash);
			expect(final.hash).toMatchSnapshot();
		});
	});

	describe("isParent", () => {
		it("returns true if entry has a child", async () => {
			const payload1 = new Uint8Array([1]);
			const payload2 = new Uint8Array([2]);
			const entry1 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
				},
				data: payload1,
				next: [],
			});
			const entry2 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
				},
				data: payload2,
				next: [entry1],
			});
			expect(Entry.isDirectParent(entry1, entry2)).toEqual(true);
		});

		it("returns false if entry does not have a child", async () => {
			const payload1 = new Uint8Array([1]);
			const payload2 = new Uint8Array([2]);
			const entry1 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
				},
				data: payload1,
				next: [],
			});
			const entry2 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
				},
				data: payload2,
				next: [],
			});
			const entry3 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
				},
				data: payload2,
				next: [entry2],
			});
			expect(Entry.isDirectParent(entry1, entry2)).toEqual(false);
			expect(Entry.isDirectParent(entry1, entry1)).toEqual(false);
			expect(Entry.isDirectParent(entry2, entry3)).toEqual(true);
		});
	});

	describe("compare", () => {
		it("returns true if entries are the same", async () => {
			const payload1 = new Uint8Array([1]);
			const entry1 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
					clock: new LamportClock({
						id: new Uint8Array([1]),
						timestamp: new Timestamp({ wallTime: 3n, logical: 2 }),
					}),
				},
				data: payload1,

				next: [],
			});
			const entry2 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
					clock: new LamportClock({
						id: new Uint8Array([1]),
						timestamp: new Timestamp({ wallTime: 3n, logical: 2 }),
					}),
				},
				data: payload1,

				next: [],
			});
			expect(Entry.isEqual(entry1, entry2)).toEqual(true);
		});

		it("returns true if entries are not the same", async () => {
			const payload1 = new Uint8Array([0]);
			const payload2 = new Uint8Array([1]);
			const entry1 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
				},
				data: payload1,
				next: [],
			});
			const entry2 = await Entry.create({
				store,
				identity: signKey,
				meta: {
					gidSeed: Buffer.from("a"),
				},
				data: payload2,
				next: [],
			});
			expect(Entry.isEqual(entry1, entry2)).toEqual(false);
		});
	});
});
