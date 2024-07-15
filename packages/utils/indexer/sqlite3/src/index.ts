import { create as sqlite3 } from "./sqlite3.js";
import { SQLiteIndices } from "./engine.js";
import { BinaryWriter } from '@dao-xyz/borsh'
import { sha256Sync, toBase58 } from '@peerbit/crypto'

export const encodeName = (name: string): string => {
    const writer = new BinaryWriter();
    writer.string(name);
    return toBase58(sha256Sync(writer.finalize()))
}

const create = async (directory?: string): Promise<SQLiteIndices> => {
    const db = await sqlite3(directory);
    return new SQLiteIndices({ db })
}
export { create }