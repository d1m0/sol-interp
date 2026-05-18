import * as fse from "fs-extra";

interface Distr {
    count: number;
    sum: number;
    min: number;
    max: number;
    ave: number;
    witnesses: {
        max: any;
        min: any;
    };
}

interface Counter {
    count: number;
    witnesses: any[];
    breakdown: { [name: string]: Counter };
}

const rootCtr: Counter = {
    count: 0,
    witnesses: [],
    breakdown: {}
};

const distrs: { [names: string]: Distr } = {};

export function recordDistr(name: string, val: number, witness: any): void {
    if (!(name in distrs)) {
        distrs[name] = {
            count: 0,
            sum: 0,
            min: Number.MAX_VALUE,
            max: Number.MIN_VALUE,
            ave: NaN,
            witnesses: {
                max: undefined,
                min: undefined
            }
        };
    }

    const d = distrs[name] as Distr;

    d.count++;
    d.sum += val;
    d.ave = d.sum / d.count;

    if (val < d.min) {
        d.min = val;
        d.witnesses.min = witness;
    }

    if (val > d.max) {
        d.max = val;
        d.witnesses.max = witness;
    }
}

export function record(name: string, witness: any, allWitnesses = true): void {
    const el = name.split(":");

    let stat: Counter = rootCtr;
    let i;

    for (i = 0; i < el.length - 1; i++) {
        if (!(el[i] in stat.breakdown)) {
            stat.breakdown[el[i]] = {
                count: 0,
                witnesses: [],
                breakdown: {}
            };
        }

        stat = stat.breakdown[el[i]];
        stat.count++;
    }

    if (!(el[i] in stat.breakdown)) {
        stat.breakdown[el[i]] = {
            count: 1,
            witnesses: [witness],
            breakdown: {}
        };
    } else {
        stat.breakdown[el[i]].count++;
        if (allWitnesses) {
            stat.breakdown[el[i]].witnesses.push(witness);
        }
    }
}

export function dump(fName: string): void {
    const outJSON = {
        counters: rootCtr,
        distributions: distrs
    };

    if (fName === "-") {
        console.error(outJSON);
    } else {
        fse.writeJsonSync(fName, outJSON, { spaces: 2 });
    }
}
