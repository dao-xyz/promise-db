import { tests } from "@peerbit/indexer-tests";
import { create } from "../src";

describe("all", () => {
	tests(create, "transient", false);
});
