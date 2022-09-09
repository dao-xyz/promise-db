import assert from 'assert'

import { default as Cache } from '@dao-xyz/orbit-db-cache'
import { Keystore } from '@dao-xyz/orbit-db-keystore';
import { Identities, Identity } from '@dao-xyz/orbit-db-identity-provider'
import { Store, DefaultOptions } from '../store'
import { Entry } from '@dao-xyz/ipfs-log-entry';
import { createStore } from './storage';
import { SimpleAccessController, SimpleIndex } from './utils';

// Test utils
const {
  config,
  testAPIs,
  startIpfs,
  stopIpfs
} = require('orbit-db-test-utils')

Object.keys(testAPIs).forEach((IPFS) => {
  describe(`Snapshots ${IPFS}`, function () {
    let ipfsd, ipfs, testIdentity: Identity, identityStore, store: Store<any>, cacheStore
    let index: SimpleIndex<string>
    jest.setTimeout(config.timeout)

    const ipfsConfig = Object.assign({}, config.defaultIpfsConfig, {
      repo: config.defaultIpfsConfig.repo + '-entry' + new Date().getTime()
    })

    beforeAll(async () => {
      identityStore = await createStore('identity')
      const keystore = new Keystore(identityStore)

      cacheStore = await createStore('cache')
      const cache = new Cache(cacheStore)

      testIdentity = await Identities.createIdentity({ id: new Uint8Array([0]), keystore })
      ipfsd = await startIpfs(IPFS, ipfsConfig.daemon1)
      ipfs = ipfsd.api

      index = new SimpleIndex();
      const options = Object.assign({}, DefaultOptions, { resolveCache: () => Promise.resolve(cache), onUpdate: index.updateIndex.bind(index) })
      store = new Store({ name: 'name', accessController: new SimpleAccessController() })
      await store.init(ipfs, testIdentity, options);

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

    it('Saves a local snapshot', async () => {
      const writes = 10

      for (let i = 0; i < writes; i++) {
        await store._addOperation({ step: i })
      }
      const snapshot = await store.saveSnapshot()
      assert.strictEqual(snapshot[0].path.length, 46)
      assert.strictEqual(snapshot[0].cid.toString().length, 46)
      assert.strictEqual(snapshot[0].path, snapshot[0].cid.toString())
      assert.strictEqual(snapshot[0].size > writes * 200, true)
    })

    it('Successfully loads a saved snapshot', async () => {
      const writes = 10

      for (let i = 0; i < writes; i++) {
        await store._addOperation({ step: i })
      }
      await store.saveSnapshot()
      index._index = [];
      await store.loadFromSnapshot()
      assert.strictEqual(index._index.length, 10)

      for (let i = 0; i < writes; i++) {
        assert.strictEqual((index._index[i] as Entry<any>).payload.value.step, i)
      }
    })

    // TODO test resume unfishid replication
  })
})
