# Changelog

## [1.0.5](https://github.com/dao-xyz/peerbit/compare/any-store-v1.0.4...any-store-v1.0.5) (2024-01-08)


### Bug Fixes

* OPFS disable createWritable ([a6d2a00](https://github.com/dao-xyz/peerbit/commit/a6d2a009165943d844aa11fe07bb90b3ab2fe5bc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @peerbit/crypto bumped from ^2.1.0 to ^2.1.1
    * @peerbit/time bumped from 2.0.0 to 2.0.1

## [1.0.4](https://github.com/dao-xyz/peerbit/compare/any-store-v1.0.3...any-store-v1.0.4) (2024-01-03)


### Bug Fixes

* make OPFS worker compatible with Safari ([8b11a44](https://github.com/dao-xyz/peerbit/commit/8b11a44f29e61f429ccea5928b1aad1d909b6f11))
* OPFS use createWritable when available ([c18a930](https://github.com/dao-xyz/peerbit/commit/c18a930bb58886c1c8e3d1b0fad4dcc593fe7339))

## [1.0.3](https://github.com/dao-xyz/peerbit/compare/any-store-v1.0.2...any-store-v1.0.3) (2024-01-02)


### Bug Fixes

* OPFS allow concurrent put ([e833b02](https://github.com/dao-xyz/peerbit/commit/e833b02e129c8f74981877ec764743452ff2c37e))

## [1.0.2](https://github.com/dao-xyz/peerbit/compare/any-store-v1.0.1...any-store-v1.0.2) (2024-01-01)


### Bug Fixes

* correctly espace illegal filename characters for OPFS ([5592761](https://github.com/dao-xyz/peerbit/commit/5592761d7b33b824655fd5a0b6deaae88eb11ccd))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @peerbit/crypto bumped from ^2.0.0 to ^2.1.0

## [1.0.1](https://github.com/dao-xyz/peerbit/compare/any-store-v1.0.0...any-store-v1.0.1) (2023-12-31)


### Bug Fixes

* add wildcard dependency on test lib ([17ee002](https://github.com/dao-xyz/peerbit/commit/17ee002b7417e45a7c45dba280d02d07e5a14c27))
* remove keychain dep ([73f622f](https://github.com/dao-xyz/peerbit/commit/73f622f9a766bb562eb427cce5fc6c6c10e47bce))

## 1.0.0 (2023-12-31)


### ⚠ BREAKING CHANGES

* modularize keychain
* lazy stream routing protocol
* File storage abstraction

### Features

* File storage abstraction ([65e0024](https://github.com/dao-xyz/peerbit/commit/65e0024216812498a00ac7922fcf30e25a357d86))
* get store size function ([87931ca](https://github.com/dao-xyz/peerbit/commit/87931ca9d20f2316426c01ee83d8ef4dd21197c1))
* lazy stream routing protocol ([d12eb28](https://github.com/dao-xyz/peerbit/commit/d12eb2843b46c33fcbda5c97422cb263ab9f79a0))
* modularize keychain ([c10f10e](https://github.com/dao-xyz/peerbit/commit/c10f10e0beb58e38fa95d465962f43ab1aee75ef))


### Bug Fixes

* 'lazy-level' to 'any-store' ([ef97f4d](https://github.com/dao-xyz/peerbit/commit/ef97f4d0f9f4c6c0684126938983d030ef04d1a0))
* update imports ([94e4f93](https://github.com/dao-xyz/peerbit/commit/94e4f93449a15e76b8d03a6459a7304ab4257ec4))
* update vite ([371bb8b](https://github.com/dao-xyz/peerbit/commit/371bb8b089873df36ff9e591b67046a7e8dab6ea))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @peerbit/crypto bumped from ^1.0.10 to ^2.0.0
    * @peerbit/logger bumped from 1.0.1 to 1.0.2
    * @peerbit/time bumped from 1.0.4 to 2.0.0