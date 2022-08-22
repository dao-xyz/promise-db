
import assert from 'assert'
import { Store, DefaultOptions, HeadsCache, IStoreOptions, StorePublicKeyEncryption } from '../store'
import { default as Cache } from '@dao-xyz/orbit-db-cache'
import { BoxKeyWithMeta, Keystore, KeyWithMeta } from "@dao-xyz/orbit-db-keystore"
import { Identities, Identity } from '@dao-xyz/orbit-db-identity-provider'
import { Index } from '../store-index'
import { createStore } from './storage'


// Test utils
const {
  config,
  testAPIs,
  startIpfs,
  stopIpfs
} = require('orbit-db-test-utils')

Object.keys(testAPIs).forEach((IPFS) => {
  describe(`addOperation ${IPFS}`, function () {
    let ipfsd, ipfs, testIdentity: Identity, keystore: Keystore, identityStore, store: Store<any, any, any, any>, cacheStore, senderKey: BoxKeyWithMeta, recieverKey: BoxKeyWithMeta, encryption: StorePublicKeyEncryption

    jest.setTimeout(config.timeout);

    const ipfsConfig = Object.assign({}, config.defaultIpfsConfig, {
      repo: config.defaultIpfsConfig.repo + '-entry' + new Date().getTime()
    })

    beforeAll(async () => {
      identityStore = await createStore('identity')
      keystore = new Keystore(identityStore)

      cacheStore = await createStore('cache')
      const cache = new Cache(cacheStore)

      testIdentity = await Identities.createIdentity({ id: new Uint8Array([0]), keystore })
      ipfsd = await startIpfs(IPFS, ipfsConfig.daemon1)
      ipfs = ipfsd.api

      const address = 'test-address'
      senderKey = await keystore.createKey('sender', BoxKeyWithMeta, undefined, { overwrite: true });
      recieverKey = await keystore.createKey('reciever', BoxKeyWithMeta, undefined, { overwrite: true });
      encryption = (_) => {
        return {
          decrypt: (data, sender, _reciever) => keystore.decrypt(data, recieverKey, sender),
          encrypt: async (data, reciever) => {
            return {
              data: await keystore.encrypt(data, senderKey, reciever),
              senderPublicKey: senderKey.publicKey
            }
          }
        }
      };
      const options: IStoreOptions<any, any, Index<any, any>> & {
        cache: Cache;
      } = Object.assign({}, DefaultOptions, { cache })
      options.encryption = encryption
      store = new Store(ipfs, testIdentity, address, options)

    })

    afterAll(async () => {
      await store?.close()
      ipfsd && await stopIpfs(ipfsd)
      await identityStore?.close()
      await cacheStore?.close()
    })

    afterEach(async () => {
      await store.drop()
      await cacheStore.open()
      await identityStore.open()
    })

    it('entry is encrypted is appended', (done) => {
      const data = { data: 12345 }

      store.events.on('write', (topic, address, entry, heads) => {
        assert.strictEqual(heads.length, 1)
        assert.strictEqual(address, 'test-address')
        assert.deepStrictEqual(entry.payload.value, data)
        assert.strictEqual(store.replicationStatus.progress, 1)
        assert.strictEqual(store.replicationStatus.max, 1)
        assert.strictEqual(store.address.root, store._index.id)
        assert.deepStrictEqual(store._index._index, heads)
        store._cache.getBinary(store.localHeadsPath, HeadsCache).then(async (localHeads) => {
          localHeads.heads[0].init({
            encoding: store.logOptions.encoding,
            encryption: store.logOptions.encryption
          });
          await localHeads.heads[0].payload.decrypt();
          assert.deepStrictEqual(localHeads.heads[0].payload.value, data)
          assert(localHeads.heads[0].equals(heads[0]))
          assert.strictEqual(heads.length, 1)
          assert.strictEqual(localHeads.heads.length, 1)
          store.events.removeAllListeners('write')
          done()
        })
      })

      store._addOperation(data, { reciever: recieverKey.publicKey })

    })


  })
})
