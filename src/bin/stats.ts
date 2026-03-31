import * as fse from "fs-extra";

interface Counter {
    count: number;
    witnesses: any[];
    breakdown: { [name: string]: Counter };
}

const root: Counter = {
    count: 0,
    witnesses: [],
    breakdown: {}
};

export function record(name: string, witness: any, allWitnesses = true): void {
    const el = name.split(":");

    let stat: Counter = root;
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
    if (fName === "-") {
        console.error(root);
    } else {
        fse.writeJsonSync(fName, root, { spaces: 2 });
    }
}
