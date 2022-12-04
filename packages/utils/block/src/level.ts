import { BlockStore, PutOptions } from "./store.js";
import {
    cidifyString,
    codecCodes,
    defaultHasher,
    stringifyCid,
} from "./block.js";
import * as Block from "multiformats/block";
import { AbstractLevel } from "abstract-level";
import { MemoryLevel } from "memory-level";
import { waitFor } from "@dao-xyz/peerbit-time";

abstract class LevelBlockStore implements BlockStore {
    _level: AbstractLevel<any, string, Uint8Array>;
    _opening: Promise<any>;
    _closed = false;
    constructor(level: AbstractLevel<any, string, Uint8Array>) {
        this._level = level;
    }

    async get<T>(
        cid: string,
        options?: {
            raw?: boolean;
            links?: string[];
            timeout?: number;
            hasher?: any;
        }
    ): Promise<Block.Block<T, any, any, any> | undefined> {
        const cidObject = cidifyString(cid);
        try {
            const bytes = await this._level.get(cid);
            const codec = codecCodes[cidObject.code];
            const block = await Block.decode({
                bytes,
                codec,
                hasher: options?.hasher || defaultHasher,
            });
            return block as Block.Block<T, any, any, any>;
        } catch (error: any) {
            if (
                typeof error?.code === "string" &&
                error?.code?.indexOf("LEVEL_NOT_FOUND") !== -1
            ) {
                return undefined;
            }
            throw error;
        }
    }

    async put(
        block: Block.Block<any, any, any, any>,
        options?: PutOptions
    ): Promise<string> {
        await this._level.put(stringifyCid(block.cid), block.bytes, {
            valueEncoding: "view",
        });
        return stringifyCid(block.cid);
    }

    async rm(cid: string): Promise<void> {
        await this._level.del(cid);
    }

    async open(): Promise<void> {
        this._closed = false;
        if (this._level.status !== "opening" && this._level.status !== "open") {
            await this._level.open();
        }
        try {
            this._opening = waitFor(() => this._level.status === "open");
            await this._opening;
        } catch (error) {
            if (this._closed) {
                return;
            }
            throw error;
        }
    }

    async close(): Promise<void> {
        this._closed = true;
        return this._level.close();
    }
}

export class MemoryLevelBlockStore extends LevelBlockStore {
    constructor() {
        super(new MemoryLevel({ valueEncoding: "view" }));
    }
}
