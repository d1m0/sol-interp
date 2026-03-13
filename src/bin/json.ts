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
        throw new Error(`JSONRPC Error: ${res.data.erorr.message}`);
    }

    if (res.data.result === undefined) {
        throw new Error(`JSONRPC Error: missing result`);
    }

    return res.data.result;
}

import * as fse from "fs-extra";
import * as path from "path";

export abstract class JSONCache {
    constructor(private readonly cacheDir: string) {
        if (!fse.existsSync(cacheDir)) {
            fse.mkdirSync(cacheDir);
        }
    }

    abstract makeKey(...args: any): string;
    abstract make(...args: any): any;

    async get(...args: any): Promise<any> {
        const key = this.makeKey(...args);

        const cachedFilePath = path.join(this.cacheDir, key + ".json");
        if (fse.existsSync(cachedFilePath)) {
            return fse.readJsonSync(cachedFilePath);
        }

        let res = this.make(...args);

        if (res instanceof Promise) {
            res = await res;
        }

        fse.writeJsonSync(cachedFilePath, res);

        return res;
    }
}
