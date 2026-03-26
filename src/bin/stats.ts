import * as fse from "fs-extra";

interface Stat {
    count: number;
    witnesses: any[];
}

interface Stats {
    [name: string]: Stat;
}

const stats: Stats = {};

export function record(name: string, witness: any): void {
    let stat: Stat;

    if (name in stats) {
        stat = stats[name];
        stat.count++;
        stat.witnesses.push(witness);
    } else {
        stat = {
            count: 1,
            witnesses: [witness]
        };
    }

    stats[name] = stat;
}

export function dump(fName: string): void {
    fse.writeJsonSync(fName, stats, { spaces: 2 });
}
