import axios from "axios"

let callIdx = 0;

export async function jsonCall(url: string, method: string, params: any[]): Promise<any> {
    const strData = JSON.stringify({ "method": method, "params": params, "id": callIdx++, "jsonrpc": "2.0" })
    const res = await axios.post(url, strData, { headers: { "Content-Type": 'application/json' } })
    if (res.status !== 200) {
        throw new Error(`HTTP Error: ${res.status}`)
    }

    if (res.data.error !== undefined) {
        throw new Error(`JSONRPC Error: ${res.data.erorr.message}`)
    }

    if (res.data.result === undefined) {
        throw new Error(`JSONRPC Error: missing result`)
    }

    return res.data.result;
}