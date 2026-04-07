import { Block } from "@ethereumjs/block";

export interface BlockManagerI {
    getBlock(number: bigint): Block | undefined;
}

export interface AsyncBlockManagerI {
    getBlock(number: bigint): Promise<Block | undefined>;
}

export class FixedSetBlockManager implements BlockManagerI {
    private blockM: Map<bigint, Block>;
    constructor(blocks: Iterable<Block>) {
        this.blockM = new Map([...blocks].map((b) => [b.header.number, b]));
    }

    getBlock(number: bigint): Block | undefined {
        return this.blockM.get(number);
    }
}

/**
 * This block manager is mostly used for testing
 */
export class FixedSetAsyncBlockManager implements AsyncBlockManagerI {
    private blockM: Map<bigint, Block>;
    constructor(blocks: Iterable<Block>) {
        this.blockM = new Map([...blocks].map((b) => [b.header.number, b]));
    }

    async getBlock(number: bigint): Promise<Block | undefined> {
        return this.blockM.get(number);
    }
}
