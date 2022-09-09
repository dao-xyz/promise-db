import { DocumentIndex, IndexedValue, Operation } from './document-index';
import { Constructor } from '@dao-xyz/borsh';
import { QueryRequestV0, Result } from '@dao-xyz/query-protocol';
import { BinaryPayload } from '@dao-xyz/bpayload';
import { AccessController, IInitializationOptions, Address } from '@dao-xyz/orbit-db-store';
import { QueryStore } from '@dao-xyz/orbit-db-query-store';
export declare class BinaryDocumentStore<T extends BinaryPayload> extends QueryStore<Operation> {
    indexBy: string;
    objectType: string;
    _clazz: Constructor<T>;
    _index: DocumentIndex<T>;
    constructor(properties: {
        name?: string;
        indexBy: string;
        objectType: string;
        accessController: AccessController<Operation>;
        queryRegion?: string;
    });
    init(ipfs: any, identity: any, options: IInitializationOptions<T>): Promise<void>;
    get(key: any, caseSensitive?: boolean): IndexedValue<T>[];
    queryDocuments(filter: ((doc: IndexedValue<T>) => boolean)): IndexedValue<T>[];
    queryHandler(query: QueryRequestV0): Promise<Result[]>;
    batchPut(docs: T[], onProgressCallback: any): Promise<import("ipfs-core-types/src/root").AddResult[]>;
    put(doc: T, options?: {}): Promise<unknown>;
    putAll(docs: T[], options?: {}): Promise<unknown>;
    del(key: any, options?: {}): Promise<unknown>;
    get size(): number;
    clone(newName: string): BinaryDocumentStore<T>;
    static load<T>(ipfs: any, address: Address, options?: {
        timeout?: number;
    }): Promise<BinaryDocumentStore<T>>;
}
