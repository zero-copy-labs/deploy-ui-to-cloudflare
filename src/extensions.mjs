import * as core from '@actions/core';
import { forEachSeries } from 'modern-async';

async function disableExtension(ext, c) {
    core.info(`Disable extension : ${ext}`);

    await c.query(`DROP EXTENSION IF EXISTS ${ext};`)

    return true;
}

export default async function run(extensions, c) { 
	await forEachSeries(extensions, async (ext) => {
        return disableExtension(ext, c);
    })
}