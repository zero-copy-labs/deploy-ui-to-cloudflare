import * as core from '@actions/core';
import { forEachSeries } from 'modern-async';

const publicFunctions = `SELECT
    routine_name
FROM 
    information_schema.routines
WHERE 
    routine_type = 'FUNCTION'
AND
    routine_schema = 'public';
`;

async function dropFunction(name, c) {
	core.info(`Drop Function: ${name}`);

	return c.query(`DROP FUNCTION IF EXISTS "${name}" CASCADE;`)
}

export default async function run(c) {
	// Find all Functions in the public schema
	const { rows: funcs }= await c.query(publicFunctions)
	
	// Delete all the included functions 
	await forEachSeries(funcs, async (func) => {
		return dropFunction(func.routine_name, c);
	})
}