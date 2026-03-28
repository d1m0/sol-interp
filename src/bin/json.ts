import axios from "axios";

let callIdx = 0;

export async function jsonCall(url: string, method: string, params: any[]): Promise<any> {
    const strData = JSON.stringify({
        method: method,
        params: params,
        id: callIdx++,
        jsonrpc: "2.0"
    });
    const res = await axios.post(url, strData, { headers: { "Content-Type": "application/json" } });
    if (res.status !== 200) {
        throw new Error(`HTTP Error: ${res.status}`);
    }

    if (res.data.error !== undefined) {
        throw new Error(`JSONRPC Error: ${res.data.error.message}`);
    }

    if (res.data.result === undefined) {
        throw new Error(`JSONRPC Error: missing result`);
    }

    return res.data.result;
}

import * as fse from "fs-extra";
import * as path from "path";

export abstract class JSONCache<T> {
    lastTime!: number;

    constructor(
        private readonly cacheDir: string,
        private readonly throttleReqPerSec?: number
    ) {
        if (!fse.existsSync(cacheDir)) {
            fse.mkdirpSync(cacheDir);
        }
    }

    abstract makeKey(...args: any): string;
    abstract make(...args: any): any;

    async get(...args: any): Promise<T> {
        const key = this.makeKey(...args);

        const cachedFilePath = path.join(this.cacheDir, key + ".json");
        if (fse.existsSync(cachedFilePath)) {
            return fse.readJsonSync(cachedFilePath);
        }

        if (this.throttleReqPerSec !== undefined) {
            const minDelta = 1000 / this.throttleReqPerSec;
            const time = Date.now();

            if (this.lastTime !== undefined) {
                const elapsed = time - this.lastTime;
                if (elapsed < minDelta) {
                    await new Promise((r) => setTimeout(r, minDelta - elapsed));
                }
            }

            this.lastTime = time;
        }
        let res = this.make(...args);

        if (res instanceof Promise) {
            res = await res;
        }

        fse.writeJsonSync(cachedFilePath, res);

        return res;
    }
}
