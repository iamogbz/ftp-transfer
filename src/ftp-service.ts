import * as core from '@actions/core';
import * as fs from 'fs';
import Client from 'ftp';
import {join} from 'path';
import {isBlank, isNotBlank} from './io-helper';

declare type Command = () => Promise<any>;

export function execute<T>(handler: (callback: (error: Error | null, result?: T | undefined) => void) => void): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
        handler((error, result) => {
            if (error)
                reject(error);
            else
                resolve(result);
        });
    });
}

export class FtpService {
    constructor(private client: Client) {
    }

    private _firstString(...args: Array<any>): string | undefined {
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (typeof arg === 'string') {
                return arg;
            }
        }
    }

    private _toArgv(command: string): string[] {
        const regexp = /([^\s'"]([^\s'"]*(['"])([^\3]*?)\3)+[^\s'"]*)|[^\s'"]+|(['"])([^\5]*?)\5/gi;
        const value = command;
        const result: string[] = [];
        let match: RegExpExecArray | null;
        do {
            match = regexp.exec(value);
            if (match !== null) {
                result.push(this._firstString(match[1], match[6], match[0])!);
            }
        } while (match !== null);
        return result;
    }

    private _toCommands(lines: string[]): Command[] {
        return lines.map(command => {
            const args = this._toArgv(command);
            if (args.length > 0) {
                switch (args[0]) {
                    case 'ls':
                        if (args.length === 1)
                            return () => {
                                core.info(`Execute '${command}'`);
                                return this.list();
                            };
                        if (args.length === 2)
                            return () => {
                                core.info(`Execute '${command}'`);
                                return this.list(args[1]);
                            };
                        break;
                    case 'get':
                        if (args.length < 4)
                            return () => {
                                core.info(`Execute '${command}'`);
                                return this.get(args[1], args[2]);
                            };
                        break;
                    case 'put':
                        if (args.length < 4)
                            return () => {
                                core.info(`Execute '${command}'`);
                                return this.put(args[1], args[2]);
                            };
                        break;
                    case 'append':
                        if (args.length < 4)
                            return () => {
                                core.info(`Execute '${command}'`);
                                return this.append(args[1], args[2]);
                            };
                        break;
                    case 'rename':
                        if (args.length === 3)
                            return () => {
                                core.info(`Execute '${command}'`);
                                return this.rename(args[1], args[2]);
                            };
                        break;
                    case 'delete':
                        if (args.length === 2)
                            return () => {
                                core.info(`Execute '${command}'`);
                                return this.delete(args[1]);
                            }
                        break;
                    case 'cd':
                        if (args.length === 2)
                            return () => {
                                core.info(`Execute '${command}'`);
                                return this.cd(args[1]);
                            };
                        break;
                    case 'mkdir':
                        if (args.length === 2)
                            return () => {
                                core.info(`Execute '${command}'`);
                                return this.mkdir(args[1]);
                            };
                        break;
                    case 'rmdir':
                        if (args.length === 2)
                            return () => {
                                core.info(`Execute '${command}'`);
                                return this.rmdir(args[1]);
                            };
                        break;
                    case 'pwd':
                        if (args.length === 1)
                            return () => {
                                core.info(`Execute '${command}'`);
                                return this.pwd();
                            };
                        break;
                }
            }
            throw new Error(`Unsupported command "${command}"`);
        });
    }

    async run(lines: string[], throwing: boolean = true): Promise<any> {
        const commands: Command[] = this._toCommands(lines);
        core.info('Executing commands');
        const output = [];
        const result: any = {
            succeed: 0,
            message: null
        };
        try {
            for (const command of commands) {
                const r: any = await command();
                result.succeed++;
                output.push(r);
            }
        } catch (e: any) {
            if (throwing)
                throw e;
            result.message = e.message;
            core.error(e.message);
        }
        output.forEach((value, index) => result[`output_${index}`] = value);
        return result;
    }

    async list(path?: string) {
        return execute(callback => {
            core.info('Listing');
            const cb = (error: Error, listing: Client.ListingElement[]) => {
                if (listing) {
                    for (const element of listing) {
                        core.info(JSON.stringify(element));
                    }
                }
                callback(error, listing != null ? JSON.stringify(listing) : null);
            };
            if (path != null)
                this.client.list(path, cb);
            else
                this.client.list(cb);
        });
    }

    private _join(dir: string, name: string): string {
        return isBlank(dir) ? name : `${dir}/${name}`;
    }

    private async _download(work: string, name: string, dest: string, override?: string) {
        let result = 0;
        const elements: Client.ListingElement[] | undefined = await execute(callback => this.client.list(callback));
        if (elements != null) {
            const dirs: string[] = [];
            core.info(`Elements: ${JSON.stringify(elements)}`);
            for (const element of elements) {
                if (isBlank(name) || element.name === name) {
                    if (element?.type === 'd') {
                        dirs.push(element.name);
                    } else if (element?.type === '-') {
                        const p = await execute(callback => this.client
                            .get(element.name, (error, stream) => {
                                let d: string | null = null;
                                if (stream != null) {
                                    d = this._join(dest, isBlank(name) || isBlank(override) ? element.name : override!);
                                    stream.pipe(fs.createWriteStream(d));
                                }
                                callback(error, d);
                            }));
                        core.info(`Downloaded file ${this._join(work, element.name)} to ${p}`);
                        result++;
                    }
                }
            }
            if (isNotBlank(name) && (dirs.length === 0 && result === 0))
                throw new Error(`Directory or file ${name} does not exist.`)

            core.info(`Directories: ${JSON.stringify(dirs)}`);
            for (const dir of dirs) {
                if (dir === "." || dir === "..") {
                    core.info("Skipping dot directories")
                    continue;
                }
                await execute(callback => this.client.cwd(dir, callback));
                const directory = this._join(dest, isBlank(name) || isBlank(override) ? dir : override!);
                if (fs.existsSync(directory)) {
                    if (!fs.lstatSync(directory).isDirectory())
                        throw new Error(`Path ${directory} is not a directory.`);
                } else {
                    fs.mkdirSync(directory);
                }
                result += await this._download(this._join(work, dir), '', directory);
                await execute(callback => this.client.cdup(callback));
            }
        }
        return result;
    }

    private async _root(): Promise<string> {
        const current: string | undefined = await execute(callback => this.client.pwd(callback));
        if (current) {
            const len = current.split('/').length;
            for (let i = 1; i < len; i++) {
                await execute(callback => this.client.cdup(callback));
            }
        }
        return current as string;
    }

    private async _combine(paths: string[]): Promise<string[]> {
        if (paths.length > 1 && paths[0] === '') {
            const current: string = await execute(callback => this.client.pwd(callback)) as any;
            const pn = current.split('/');
            const l = pn.length;
            if (l > 1 && pn[0] === '') {
                let index = 0;
                const len = paths.length;
                for (let i = 1; i < len && i < l; i++) {
                    const p = paths[i];
                    if (p !== pn[i]) {
                        index = i;
                        break;
                    }
                }
                if (index > 1) {
                    return pn.slice(index, l).map(() => '..').concat(paths.slice(index, len));
                }
            }
        }
        return paths;
    }

    private async _back(path: string | number) {
        if (path != null) {
            if (typeof path === 'string') {
                const paths = await this._combine(path.split('/'));
                for (let i = 0, len = paths.length; i < len; i++) {
                    const p = paths[i];
                    if (isBlank(p)) {
                        if (i === 0)
                            await this._root();
                        else
                            break;
                    } else if (p === '.') {
                        continue;
                    } else if (p === '..') {
                        await execute(callback => this.client.cdup(callback));
                    } else {
                        await execute(callback => this.client.cwd(paths[i], callback));
                    }
                }
            } else {
                while (path > 0) {
                    await execute(callback => this.client.cdup(callback));
                    path--;
                }
            }
        }
    }

    private _dirname(path: string) {
        if (isBlank(path) || path === '.')
            return '';
        if (path.endsWith('/'))
            return path;
        const paths = path.split('/');
        if (paths.length > 0)
            return paths.slice(0, paths.length - 1).join('/');
        return '';
    }

    private _basename(path: string) {
        if (isBlank(path) || path.endsWith('/') || path === '.')
            return '';
        const paths = path.split('/');
        if (paths.length > 0)
            return paths[paths.length - 1];
        return '';
    }

    async get(path: string, dest?: string) {
        let work = '', next = '', over = '';
        if (dest != null) {
            if (dest.endsWith('/')) {
                dest = dest.slice(0, dest.length - 1);
            } else {
                over = this._basename(dest);
                dest = this._dirname(dest);
            }
        } else {
            dest = '.';
        }
        const paths = this._split(path, true);
        let back: any;
        if (paths.length > 0) {
            next = paths[paths.length - 1];
            back = await this._cd(paths.slice(0, paths.length - 1), false);
            work = await execute(callback => this.client.pwd(callback)) as any;
        } else
            throw new Error(`Path ${path} is invalid.`);
        const result = await this._download(work, next, dest, over);
        if (back != null)
            await this._back(back.back);
        return result;
    }

    private _split(path: string, blank: boolean = true): string[] {
        const paths = path!.split('/');
        const result: string[] = [];
        const len = paths.length;
        let s = false;
        for (let i = 0; i < len; i++) {
            const p = paths[i];
            if (isBlank(p)) {
                if (i > 0) {
                    if (i == len - 1) {
                        if (!blank) break;
                    } else
                        throw new Error(`The path ${path} is invalid.`);
                }
                s = true;
            } else if (p === '.') {
                if (i > 0)
                    throw new Error(`The path ${path} is invalid.`);
                s = true;
                continue;
            } else if (p === '..') {
                if (s)
                    throw new Error(`The path ${path} is invalid.`);
            } else {
                s = true;
            }
            result.push(p);
        }
        return result;
    }

    private async _cd(path: string | string[], create: boolean = true, exits: boolean = true): Promise<{ success: boolean; back: number | string; }> {
        let back: string | number = 0;
        let paths: string[] = [];
        if (typeof path === 'string')
            paths = this._split(path, false);
        else {
            if (path != null)
                paths = path;
            path = paths.join('/');
        }
        paths = await this._combine(paths);
        for (let i = 0, len = paths.length; i < len; i++) {
            const p = paths[i];
            if (isBlank(p)) {
                if (i === 0)
                    back = await this._root();
                else
                    throw new Error(`The path ${path} is invalid.`);
            } else if (p === '.') {
                if (i == 0)
                    continue;
                else
                    throw new Error(`The path ${path} is invalid.`);
            } else if (p === '..') {
                if (back === 0)
                    back = await execute(callback => this.client.pwd(callback)) as any;
                await execute(callback => this.client.cdup(callback));
            } else {
                const elements: any[] = await execute(callback => this.client.list(callback)) ?? [];
                const type = elements.find(value => value.name === p)?.type;
                if (type == null) {
                    if (create)
                        await execute(callback => this.client.mkdir(p, callback));
                    else if (exits)
                        throw new Error(`The path ${path} does not exits.`)
                    else {
                        core.warning(`The path ${path} does not exits.`);
                        return {success: false, back};
                    }
                }
                if (type == null || type === 'd')
                    await execute(callback => this.client.cwd(p, callback));
                else
                    throw new Error(`The path ${path} is not a directory.`);
                if (typeof back === 'number')
                    back++;
            }
        }
        return {success: true, back};
    }

    private async _transfer(append: boolean, path: string, work: string, name: string) {
        await execute(callback => {
            if (append)
                this.client.append(path, name, callback);
            else
                this.client.put(path, name, callback);
        });
        core.info(`Uploaded file ${path} to ${this._join(work, name)}`);
    }

    private async _upload(append: boolean, path: string, work: string, name?: string) {
        const lstat = fs.lstatSync(path);
        let result = 0;
        if (lstat.isFile()) {
            await this._transfer(append, path, work, name ?? this._basename(path));
            result++;
        } else if (lstat.isDirectory()) {
            if (isNotBlank(name)) {
                let create = true;
                const elements: any[] = await execute(callback => this.client.list(callback)) ?? [];
                const f = elements.find(value => value.name === name!);
                if (f != null) {
                    if (f.type === 'd') {
                        if (append)
                            create = false;
                        else
                            await this._rmdir(name!, work);
                    } else
                        await execute(callback => this.client.delete(name!, callback));
                }
                if (create)
                    await execute(callback => this.client.mkdir(name!, callback));
                work = this._join(work, name!);
                await execute(callback => this.client.cwd(name!, callback));
            }
            const elements = fs.readdirSync(path);
            for (const element of elements) {
                const p = join(path, element);
                result += await this._upload(append, p, work, element);
            }
            if (isNotBlank(name)) {
                await execute(callback => this.client.cdup(callback));
            }
        } else {
            throw new Error(`Path ${path} is invalid.`);
        }
        return result;
    }

    private async _put(append: boolean, path: string, dest?: string) {
        let back: any, work = '', next = '';
        if (isBlank(dest)) {
            work = '';
            next = path.endsWith('/') ? '' : this._basename(path);
        } else if (dest?.endsWith('/')) {
            work = dest!.slice(0, dest?.length - 1);
            next = path.endsWith('/') ? '' : this._basename(path);
        } else {
            work = this._dirname(dest!);
            next = this._basename(dest!);
        }
        if (isNotBlank(work))
            back = await this._cd(work);
        const result = await this._upload(append, path, work, next);
        if (back != null) {
            await this._back(back.back);
        }
        return result;
    }

    async put(path: string, dest?: string) {
        return await this._put(false, path, dest);
    }

    async append(path: string, dest?: string) {
        return await this._put(true, path, dest);
    }

    async rename(oldPath: string, newPath: string) {
        await execute(callback => this.client.rename(oldPath, newPath, callback));
        core.info(`Renamed ${oldPath} to ${newPath}`);
        return true;
    }

    async delete(path: string) {
        const paths = this._split(path, false);
        const len = paths.length;
        if (len == 0 || paths[len - 1] === '')
            throw new Error(`The path ${path} is invalid.`);
        const name = paths[len - 1];
        const back = await this._cd(paths.slice(0, len - 1), false, false);
        let result = 0;
        if (back.success) {
            const elements: any[] = await execute(callback => this.client.list(callback)) ?? [];
            const type = elements.find(value => value.name === name)?.type;
            if (type == null)
                core.warning(`The path ${path} does not exits.`);
            else if (type === 'd') {
                result += await this._rmdir(name, paths.join('/'));
                core.info(`Deleted directory ${path}`);
            } else if (type === '-') {
                await execute(callback => this.client.delete(name, callback));
                core.info(`Deleted file ${path}`);
                result++;
            }
        }
        await this._back(back.back);
        return result;
    }

    async cd(path: string) {
        await this._cd(path, false);
        core.info(`Changed working directory to ${path}`);
        return true;
    }

    async pwd() {
        const path: string = await execute(callback => this.client.pwd(callback)) as any;
        core.info(`Current directory ${path}`);
        return path;
    }

    async mkdir(path: string) {
        const back = await this._cd(path, true);
        core.info(`Created directory ${path}`);
        await this._back(back.back);
        return true;
    }

    private async _rmdir(name: string, path: string) {
        let result = 0;
        await execute(callback => this.client.cwd(name, callback));
        const elements: any[] = await execute(callback => this.client.list(callback)) ?? [];
        for (const element of elements) {
            if (element.type === 'd') {
                result += await this._rmdir(element.name, this._join(path, element.name));
            } else {
                await execute(callback => this.client.delete(element.name, callback));
                core.info(`Deleted file ${this._join(path, element.name)}`);
                result++;
            }
        }
        await execute(callback => this.client.cdup(callback));
        await execute(callback => this.client.rmdir(name, callback));
        core.info(`Removed directory ${path}`);
        return result;
    }

    async rmdir(path: string) {
        const paths = this._split(path, false);
        const len = paths.length;
        if (len == 0 || paths[len - 1] === '')
            throw new Error(`The path ${path} is invalid.`);
        const back = await this._cd(paths.slice(0, len - 1), false);
        let result = 0;
        if (back.success) {
            result += await this._rmdir(paths[len - 1], paths.join('/'));
        }
        await this._back(back.back);
        return result;
    }
}
