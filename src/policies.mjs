import * as core from '@actions/core';
import { forEachSeries } from 'modern-async';

const polices = `SELECT * FROM pg_policies;`

async function dropPolicy(schema, table, name, c) {
    core.info(`Drop Policy: ${name} ON ${schema}.${table}`);

    return c.query(`DROP POLICY IF EXISTS "${name}" ON "${schema}"."${table}" CASCADE;`)
}

export default async function run(c) { 
	// Find all polices
    const { rows: policyList }= await c.query(polices)

    // Delete polices
    await forEachSeries(policyList, async (p) => {
        return dropPolicy(p.schemaname, p.tablename, p.policyname, c);
    })
}