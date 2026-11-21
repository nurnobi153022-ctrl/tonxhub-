import { pathToFileURL } from 'node:url';
import path from 'node:path';
const dir = path.resolve('tests/stubs');
export async function resolve(spec, ctx, next) {
    try { return await next(spec, ctx); }
    catch (e) {
        if (spec === 'mongodb') return { url: pathToFileURL(path.join(dir, 'mongodb.mjs')).href, shortCircuit: true };
        if (spec === '@vercel/functions') return { url: pathToFileURL(path.join(dir, 'vercel-functions.mjs')).href, shortCircuit: true };
        throw e;
    }
}
