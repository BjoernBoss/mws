/* SPDX-License-Identifier: BSD-3-Clause */
/* Copyright (c) 2026 Bjoern Boss Henrichsen */
import { Config as libConfig } from "./config.js";
import * as libLog from "./log.js";
import * as libLocation from "./location.js";
import * as libFs from "fs";
import * as libStream from "stream";
import * as libCrypto from "crypto";

const logger = libLog.Logger('cache');

const ID_EXTENSION_REGEX: RegExp = /^\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function ReadStats(path: string): null | [number, number] {
	try {
		const stats = libFs.statSync(path);
		if (stats.isFile())
			return [stats.size, stats.mtimeMs];
	} catch (err: any) {
		if (err.code == 'ENOENT')
			return null;
		logger.error(`Filesystem error while checking [${path}]: ${err.message}`);
		throw new Error('File operation failed');
	}
	return null;
}

interface CacheEntry {
	data: Buffer;
	mtime: number;
	age: number;
	touched: number;
}
class CacheManager {
	private map: Record<string, CacheEntry> = {};
	private nextStamp: number = 0;
	private allocated: number = 0;
	private totalCapacity: number;
	private largestSize: number;

	public constructor() {
		this.totalCapacity = libConfig.cacheSize;
		this.largestSize = libConfig.cacheFileSizeLimit;
		libConfig.subscribe(() => this.applyConfig());
	}

	private applyConfig(): void {
		this.totalCapacity = Math.max(libConfig.cacheSize, 0);
		this.largestSize = Math.max(libConfig.cacheFileSizeLimit, 0);

		/* check if the cache needs to be reduced */
		if (this.allocated > this.totalCapacity)
			this.reduce(this.allocated - this.totalCapacity);
	}
	private reduce(capacity: number): void {
		/* create the list of all cached objects sorted by the touched count */
		const paths: string[] = Object.keys(this.map).sort((a, b) => this.map[a].touched - this.map[b].touched);

		/* drop the first half of the entries or more, if the size has not yet been freed (valid as callers
		*	guarantee capacity <= allocated, thus the capacity will reach <= 0 before i overflows the paths) */
		for (let i = 0; i < (paths.length + 1) / 2 || capacity > 0; ++i) {
			capacity -= this.map[paths[i]].data.byteLength;
			this.drop(paths[i]);
		}
	}

	public add(path: string, data: Buffer, mtime: number, age: number): void {
		if (!this.cacheable(data.byteLength))
			return;

		/* check if the entry is already part of the cache and check if the current entry should be evicted */
		if (path in this.map) {
			const entry = this.map[path];
			if (entry.age >= age)
				return;
			this.drop(path);
		}

		/* check if space needs to be reserved */
		if (this.allocated + data.byteLength > this.totalCapacity)
			this.reduce(this.allocated + data.byteLength - this.totalCapacity);

		/* add the entry to the cache */
		logger.log(`Added [${path}] to the cache`);
		this.allocated += data.byteLength;
		this.map[path] = { data, mtime, touched: ++this.nextStamp, age };
	}
	public drop(path: string): void {
		if (!(path in this.map))
			return;
		logger.log(`Dropped [${path}] from the cache`);
		this.allocated -= this.map[path].data.byteLength;
		delete this.map[path];
	}
	public cacheable(size: number): boolean {
		return (size <= this.largestSize && size <= this.totalCapacity);
	}
	public flush(): void {
		this.map = {};
		this.allocated = 0;
	}
	public find(path: string, stats: { mtime: number, size: number } | null): CacheEntry | null {
		const entry = this.map[path] ?? null;
		if (entry == null)
			return null;

		/* check if the entry can be considered stable and otherwise that the entry is still up-to-date and return it */
		if (stats == null || (entry.mtime == stats.mtime && entry.data.length == stats.size)) {
			entry.touched = ++this.nextStamp;
			return entry;
		}

		/* remove the entry as it seems to be outdated */
		this.drop(path);
		return null;
	}
}

interface ImmutableEntry {
	immutable: string;
	actual: string | null;
	size: number;
	mtime: number;
	id: string;
	fetched: boolean;
}
interface ImmutableSerialized {
	id: string;
	src: string;
	dst: string | null;
	size: number;
	mtime: number;
}
class ImmutableManager {
	private map: Record<string, ImmutableEntry> = {};
	private reverse: Record<string, string> = {};
	private writeBack: { path: string, writing: Promise<void> | null, dirty: boolean } | null = null;

	private assignId(path: string, entry: ImmutableEntry): void {
		if (entry.id.length > 0)
			delete this.reverse[entry.id];

		/* allocate the new id and patch the state up to contain the new id */
		const id = libCrypto.randomUUID();
		const [base, name, extension] = libLocation.SplitFilePath(path);
		const idPath = `${base}${name}.${id}${extension}`;
		logger.trace(`Allocated immutable id [${id}] for [${path}]`);

		entry.immutable = idPath;
		entry.id = id;
		this.reverse[id] = path;
	}
	private async storeState(): Promise<void> {
		if (this.writeBack == null)
			return;
		this.writeBack.dirty = true;
		if (this.writeBack.writing != null)
			return;

		let resolve: null | (() => void) = null;
		this.writeBack.writing = new Promise((res) => resolve = res);

		/* check if the state is dirty and perform the write backs */
		while (this.writeBack.dirty) {
			this.writeBack.dirty = false;

			/* collect the list of all relevant entries */
			let output: any[] = [];
			for (const srcPath in this.map) {
				const entry = this.map[srcPath];
				if (entry.actual != null)
					output.push({ id: entry.id, src: srcPath, dst: entry.actual, size: entry.size, mtime: entry.mtime });
			}
			const content: string = JSON.stringify(output);

			/* ignore any read/write failures */
			await libLocation.AtomicWrite(this.writeBack.path, content, 'immutable state', logger);
		}

		this.writeBack.writing = null;
		resolve!();
	}
	private async loadState(path: string): Promise<ImmutableSerialized[]> {
		logger.trace(`Loading immutable state from [${path}]`);

		/* load the current file and parse it as json (skip any content failed to be read or if the file did not exist) */
		let state: unknown = null;
		try {
			const data = await new Promise<string>((resolve, reject) => libFs.readFile(path, { encoding: 'utf-8' }, (err: any, data: string) => {
				if (err == null)
					resolve(data);
				else
					reject(err);
			}));
			state = JSON.parse(data);
		} catch (err: any) {
			if (err.code != 'ENOENT')
				logger.error(`Error while loading immutable state from [${path}]: ${err.message}`);
			return [];
		}

		if (!Array.isArray(state)) {
			logger.error(`Immutable state [${path}] is malformed (discarding state)`);
			return [];
		}

		/* parse all of the values and validate their general structure */
		let corrupted = 0, output: ImmutableSerialized[] = [];
		for (const entry of state) {
			if (typeof entry.id != 'string' || typeof entry.src != 'string' || (typeof entry.dst != 'string' && entry.dst !== null))
				++corrupted;
			else if (typeof entry.size != 'number' || !isFinite(entry.size) || entry.size < 0)
				++corrupted;
			else if (typeof entry.mtime != 'number' || !isFinite(entry.mtime) || entry.mtime < 0)
				++corrupted;
			else
				output.push({ id: entry.id, src: entry.src, dst: entry.dst, size: entry.size, mtime: entry.mtime });
		}

		if (corrupted > 0)
			logger.error(`Immutable loaded state [${path}] contained [${corrupted}] malformed entires`);
		return output;
	}

	public make(path: string): string {
		if (!libConfig.cacheAllowImmutable)
			return path;

		/* check if the entry already exists and otherwise create the
		*	new immutable entry and return the id-tagged path */
		let entry = this.map[path] ?? null;
		if (entry != null)
			return entry.immutable;

		entry = (this.map[path] = { immutable: '', id: '', actual: null, size: 0, mtime: 0, fetched: false });
		this.assignId(path, entry);

		return entry.immutable;
	}
	public get(path: string, stable: boolean): [ImmutableEntry | null, boolean] {
		if (!libConfig.cacheAllowImmutable)
			return [null, false];

		/* check if it might be an immutable-id */
		const [base, temp, extension] = libLocation.SplitFilePath(path);
		const [_, name, tempId] = libLocation.SplitFilePath(temp);
		if (!tempId.match(ID_EXTENSION_REGEX))
			return [null, false];
		const id = tempId.substring(1);

		/* check if the entry does not exist in the reverse mapping anymore - indicating that the id is
		*	old/outdated, in which case it can be recovered by comparing the full actual path to all of
		*	the entries, looking for the actual object, thereby recovering the most recent immutable path */
		let srcPath = this.reverse[id] ?? null;
		if (srcPath == null) {
			const actualPath = `${base}${name}${extension}`;
			for (const tempPath in this.map) {
				if (this.map[tempPath].actual != actualPath)
					continue;
				srcPath = tempPath;
				break;
			}
			if (srcPath == null)
				return [null, false];
		}
		const entry = this.map[srcPath]!, firstFetch = (entry.actual == null);
		if (entry.actual == null)
			entry.actual = `${base}${name}${extension}`;

		/* check if the entry can just be served (id might still be oudated) and otherwise fetch the initial stats */
		if (entry.fetched && stable)
			return [entry, entry.id != id];
		const stats = ReadStats(entry.actual);
		if (stats == null) {
			logger.warning(`Immutable path [${entry.actual}] does not exist`);
			delete this.map[srcPath];
			delete this.reverse[id];
			this.storeState();
			return [null, false];
		}
		const [fileSize, mtime] = stats;

		/* check if the stats have changed, in which case a new id needs to be assigned (thus binding the id to the stats) */
		const statsChanged = (entry.size != fileSize || entry.mtime != mtime);
		if (!firstFetch && statsChanged)
			this.assignId(srcPath, entry);
		entry.size = fileSize;
		entry.mtime = mtime;
		entry.fetched = true;

		if (firstFetch || statsChanged)
			this.storeState();
		return [entry, entry.id != id];
	}
	public invalidate(): void {
		for (const path in this.map)
			this.map[path].fetched = false;
	}
	public async setWriteBack(path: string): Promise<void> {
		/* fetch the new state to be written back (before updating the write-back to ensure
		*	the async operation does not result in the file being overwritten before being read) */
		let states = ((path == '' || path == this.writeBack?.path) ? [] : await this.loadState(path));

		/* wait for any current write-backs to be complete (loop to prevent race-conditions
		*	between resolving the promise and performing the next write-back) */
		while (this.writeBack?.writing != null)
			await this.writeBack.writing;
		if (path == '') {
			this.writeBack = null;
			return;
		}

		/* merge the loaded state into the current state (prefer current state over loaded state) */
		for (const state of states) {
			if (state.src in this.map)
				continue;
			logger.trace(`Recovering immutable id [${state.id}] for [${state.src}]`);

			const [base, name, extension] = libLocation.SplitFilePath(state.src);
			this.map[state.src] = {
				immutable: `${base}${name}.${state.id}${extension}`,
				actual: state.dst,
				size: state.size,
				mtime: state.mtime,
				id: state.id,
				fetched: false
			};
			this.reverse[state.id] = state.src;
		}

		/* check if the writeback should be configured and perform the first write back */
		if (this.writeBack == null)
			this.writeBack = { path, writing: null, dirty: false };
		else if (this.writeBack.path == path)
			return;
		this.storeState();
	}
}
const cacheManager: CacheManager = new CacheManager();
const immutableManager: ImmutableManager = new ImmutableManager();

export class Cached {
	private path: string;
	private size: number;
	private data: Buffer | null;
	private mtime: number;
	private immutable: boolean;
	private age: number;

	public constructor(path: string, size: number, data: Buffer | null, mtime: number, age: number, immutable: boolean) {
		this.path = path;
		this.size = size;
		this.data = data;
		this.mtime = mtime;
		this.immutable = immutable;
		this.age = age;
	}
	private makeStream(options?: { start?: number, end?: number }): libStream.Readable {
		/* check if the data have already been cached */
		if (this.data != null)
			return libStream.Readable.from(this.data.subarray(options?.start, (options?.end == null ? undefined : options.end + 1)));

		/* create the data stream */
		let stream: libFs.ReadStream | null = null;
		try {
			stream = libFs.createReadStream(this.path, { flags: 'r', start: options?.start, end: options?.end });
		} catch (err: any) {
			return new libStream.Readable({ read() { this.destroy(new Error(`Error reading file: ${err.message}`)) } });
		}

		/* check if only a partial file is being read, or it is too large, in which case it will not be added to the cache */
		if (!cacheManager.cacheable(this.size) || (options?.start != null && options.start != 0) || (options?.end != null && options.end + 1 != this.size))
			return stream;

		/* create the transformer stream to cache the data */
		let buffers: Buffer[] = [], settled: boolean = false, totalLength: number = 0;
		const transformer = new libStream.Transform({
			transform: (chunk, _, cb) => {
				if (settled) return cb(new Error('Reading already completed'));
				totalLength += chunk.byteLength;
				buffers.push(chunk);
				cb(null, chunk);
			},
			final: (cb) => {
				if (settled) return cb(new Error('Reading already completed'));
				if (totalLength == this.size && cacheManager.cacheable(this.size))
					cacheManager.add(this.path, Buffer.concat(buffers), this.mtime, this.age);
				cb(null);
			}
		});

		/* setup the file exceptions to be propagated to the stream */
		let wrapped = stream.pipe(transformer);
		stream.on('error', (err: any) => {
			if (settled) return; settled = true;
			wrapped.destroy(err);
		});
		wrapped.on('error', (err: any) => {
			if (settled) return; settled = true;
			stream.destroy(err);
		});
		return wrapped;
	}

	/* check if this is an immutable file entry */
	public isImmutable(): boolean {
		return this.immutable;
	}

	/* size in bytes of the file */
	public fileSize(): number {
		return this.size;
	}

	/* fetch the last modified time formatted for the network */
	public lastModified(): string {
		return new Date(this.mtime).toUTCString();
	}

	/* fetch the unique-id to identify this version of the cached file (constructed,
	*	just like the cache identifies them as equivalent: size+last-modified) */
	public uniqueId(): string {
		return `${this.mtime}-${this.size}`;
	}

	/* [no-throw] object must not be used anymore after reading or streaming from it */
	public stream(options?: { start?: number, end?: number }): libStream.Readable {
		return this.makeStream(options);
	}

	/* [throws] object must not be used anymore after reading or streaming from it */
	public readSync(): Buffer {
		/* check if the data have already been cached */
		if (this.data != null)
			return this.data;

		/* read the data into memory */
		try {
			this.data = libFs.readFileSync(this.path);
		} catch (err: any) {
			throw new Error(err);
		}

		/* check if the file-size changed mid operation */
		if (this.data.byteLength != this.size)
			throw new Error(`File size changed mid operation: [${this.data.byteLength}] != [${this.size}]`);

		/* add the read buffer back to the cache (using the fetched data from before
		*	reading the file - to detect a file-change since before reading the file) */
		cacheManager.add(this.path, this.data, this.mtime, this.age);
		return this.data;
	}

	/* [throws] object must not be used anymore after reading or streaming from it */
	public async readAsync(): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const stream: libStream.Readable = this.makeStream();
			const buffers: Buffer[] = [];
			let settled: boolean = false;

			/* register the handler to collect the data and stream them out */
			stream.on("data", (chunk) => {
				if (!settled)
					buffers.push(chunk);
			});
			stream.on("error", (err) => {
				if (!settled) {
					settled = true;
					reject(err);
				}
			});
			stream.on("end", () => {
				if (!settled) {
					settled = true;
					resolve(Buffer.concat(buffers));
				}
			});
		});
	}
}

function ResolveCache(path: string, stable: boolean, checkImmutable: boolean): Cached | string | null {
	stable = (stable && libConfig.cacheAllowStable);

	/* check if the entry is immutable and fetch its actual path or
	*	if it has been moved (due to the id having been invalidated) */
	const [immutable, immutableMoved] = (checkImmutable ? immutableManager.get(path, stable) : [null, false]);
	if (immutable != null) {
		path = immutable.actual!;
		if (immutableMoved)
			return immutable.immutable;
	}
	const isImmutable = (immutable != null);

	/* check if the entry is stable and already in the cache, in which case the file doesn't even need to be checked */
	let entry = (stable ? cacheManager.find(path, null) : null);
	if (entry != null && (immutable == null || (immutable.size == entry.data.byteLength && immutable.mtime == entry.mtime)))
		return new Cached(path, entry.data.byteLength, entry.data, entry.mtime, entry.age, isImmutable);

	/* check if the file exists and read its file-size and mtime (not necessary
	*	for immutable entries, as their stats are already up-to-date) */
	const stats = (immutable == null ? ReadStats(path) : [immutable.size, immutable.mtime]);
	if (stats == null)
		return null;
	const [fileSize, mtime] = stats;
	const age = Date.now();

	/* check if the path exists in the validated cache and otherwise return the uncached entry */
	entry = cacheManager.find(path, { mtime, size: fileSize });
	if (entry != null)
		return new Cached(path, fileSize, entry.data, mtime, age, isImmutable);
	return new Cached(path, fileSize, null, mtime, age, isImmutable);
}

/* [stable]: if cached as stable, dont re-validate the file stats before serving from cache; resolve immutable ids automatically (Cached to
*	interact with cache; null, if it does not exist, string if the immutable path has been permanently moved to the new path in source space) */
export function GetImmutable(path: string, stable: boolean): Cached | string | null {
	return ResolveCache(path, stable, true);
}

/* [stable]: if cached as stable, dont re-validate the file stats before serving from cache;
*	no immutable ids are resolved (Cached to interact with cache; null, if it does not exist) */
export function GetActual(path: string, stable: boolean): Cached | null {
	return ResolveCache(path, stable, false) as (Cached | null);
}

/* generate a unique tagged path for the given query path, which will change whenever the underlying file changes (creates
*	a path to a file, which looks similar to the source, except that the name includes a UUID, which will be used to identity
*	the given file state; will be removed from the final target path to be served, to identify the actual source) */
export function MakeImmutable(path: string): string {
	return immutableManager.make(path);
}

/* flush all cached data and invalidate immutable stats so they are re-checked on next access */
export function FlushCache(): void {
	logger.info('Flushing cache and invalidating immutable entries');
	cacheManager.flush();
	immutableManager.invalidate();
}

/* configure the write back of the immutable state to ensure persistent ids across restarts
*	(will be read upon configuring; if not configured, ids will be lost after a server restart) */
export async function ConfigureWriteBack(path: string | null): Promise<void> {
	await immutableManager.setWriteBack(path ?? '');
}
