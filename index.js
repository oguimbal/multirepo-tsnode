var Module = require('module');
const path = require('path');
const fs = require('fs');
const tsNode = require('ts-node');
const tsconfigPaths = require('tsconfig-paths');

// debugger;
function normalize(p) {
    return p.replace(/\\/g, '/');
}

function findParent(p, fn) {
    const target = normalize(p).split(/\//g);
    while (target.length) {
        const ret = fn(target.join('/'));
        if (ret)
            return ret;
        target.pop();
    }
}

function register(options) {

    options = {
        cwd: process.cwd(),
        ...options || {}
    };

    options.cwd = normalize(options.cwd)

    const config = findParent(options.cwd, p => {
        const cfgPath = path.join(p, 'multirepo.json');
        if (!fs.existsSync(cfgPath))
            return;
        try {
            return {
                __dirname: p + '/',
                __filename: cfgPath,
                ...JSON.parse(fs.readFileSync(cfgPath, 'utf8')),
            };
        } catch (e) {
            // nop
        }
    });

    if (!config || !config.packages) {
        console.warn('Was expecting "packages" to be defined in multirepo.json');
        return;
    }

    const moved = Object.keys(config.packages)
        .filter(pk => {
            const p = config.packages[pk];
            const target = normalize(path.resolve(options.cwd, p));
            if (config.__dirname.startsWith(target + '/'))
                return false; // targets a child directory => ignore
            
            // find a tsconfig.json that must be in parent of target
            return findParent(target, p => fs.existsSync(path.join(p, 'tsconfig.json')));
        }).map  (pk => {
            const ret = config.packages[pk];
            const toResolved = normalize(path.resolve(config.__dirname, ret));
            return {
                from: pk,
                toResolved: toResolved + '/',
                to: ret,
                relative: './', // relative.length ? './' + relative.join('/') + '/' : './',
            };
        });

    const oldCwd = process.cwd();

    // register the global handlers

    const toHandle = ['.ts', '.tsx', '.jsx']; // '.js'
    const finalExtensions = new Set();
    const resolveBySource = {};
    const originalResolveFilename = Module._resolveFilename;
    const originalExtensions = {};
    ['.js', ...toHandle].forEach(x => originalExtensions[x] = require.extensions[x]);

    let main;
    for (const _m of [
        {from: options.cwd, relative: './', toResolved: options.cwd + '/', to: options.cwd}
        , ...moved])
    {
        const m = _m;
        if (!fs.existsSync(m.toResolved)) {
            console.log('Using npm package for ' + m.from + ' because target does not exist: ' + m.toResolved);
            continue;
        }
        process.chdir(m.toResolved);

        const reg = tsNode.register();
        const tsconfigPath = reg.ts.findConfigFile(m.toResolved, fs.existsSync);
        const {config: tsconfig} = reg.ts.readConfigFile(tsconfigPath, x => fs.readFileSync(x, 'utf8'));
                finalExtensions.add(...reg.extensions);
        tsconfigPaths.register();
        
        // save handlers & undo registrations
        const rkey = m.from + '/';
        const rootResolved = normalize(path.dirname(tsconfigPath)) + '/';
        const cur = resolveBySource[rkey] = resolveBySource[rootResolved] = {
            resolve: Module._resolveFilename,
            extensions: {},
            cfg: {...m},
            tsconfig: tsconfig,
            rootResolved: rootResolved,
            lookupPathsFor(file) {
                const fileNorm = normalize(file);
                for (const other of Object.keys(resolveBySource)) {
                    const target = resolveBySource[other];
                    if (fileNorm.startsWith(other) || (fileNorm + '/') === other) {
                        // import 'replaced-module/*'
                        const ret = path.normalize(target.rootResolved);
                        return [ret]
                    }
                }
                
                for (const e of toHandle) {
                    // import 'src/path/to/file'
                    if (fs.existsSync(this.rootResolved + file + e) || fs.existsSync(this.rootResolved + file + '/index' + e)) {
                        const ret = path.normalize(this.rootResolved);
                        return [ret]
                    }
                }

                if (file[0] === '.')
                    return null;

                // forces to load all dependencies with the main module.
                // this ensures that common dependencies are not loaded twice.
                // => which results in same types loaded twice, and thus not equal
                // (might cause trouble with dependency injection, or with "instanceof")
                {
                    const ret = path.normalize(main.rootResolved);
                    return [ret,
                        path.join(ret, 'node_modules'),
                        path.join(rootResolved, 'node_modules'), // <= for packages only installed on target repository

                    ];
                }
            },
            resolveTarget(file) {
                const fileNorm = normalize(file);
                if (file[0] === '.')
                    return {
                        target: this,
                        targetFile: fileNorm,
                    }
                // find in replacements
                for (const other of Object.keys(resolveBySource)) {
                    const target = resolveBySource[other];
                    if (fileNorm.startsWith(target.cfg.toResolved)) {
                        // import '/absolute/to/replaced/*'
                        const suffix = file.substr(target.cfg.toResolved.length);
                        return {
                            target: target,
                            targetFile: path.normalize(target.cfg.toResolved + suffix),
                        }
                    }
                    if (fileNorm.startsWith(other)|| (fileNorm + '/') === other) {
                        // import 'replaced-module/*'
                        const suffix = file.substr(other.length);
                        return {
                            target: target,
                            targetFile: path.normalize(target.cfg.toResolved + suffix),
                        };
                    }
                }
                
                for (const e of toHandle) {
                    // import 'src/path/to/file'
                    if (fs.existsSync(this.rootResolved + file + e) || fs.existsSync(this.rootResolved + file + '/index' + e)) {
                        return {
                            target: this,
                            targetFile: file,
                        };
                    }
                }

                if (tsconfig.compilerOptions && tsconfig.compilerOptions.paths) {
                    for (const k of Object.keys(tsconfig.compilerOptions.paths)) {
                        if (k === file) {
                            // import '@something-in-paths'
                            // => return it as it (will be parsed by tsconfig/paths)
                            return {
                                target: this,
                                targetFile: file,
                            };
                        }
                    }
                }

                // forces to load all dependencies with the main module.
                // this ensures that common dependencies are not loaded twice.
                // => which results in same types loaded twice, and thus not equal
                // (might cause trouble with dependency injection, or with "instanceof")
                return {target: main, targetFile: file};
            }
        };
        main = main || cur;
        toHandle.forEach(x => {
            cur.extensions[x] = require.extensions[x];
            require.extensions[x] = originalExtensions[x];
        });
        Module._resolveFilename = originalResolveFilename;
    }

    function resolveSource(mod) {
        if (!mod || mod === process.mainModule)
            return main;
        if (normalize(mod.filename).includes('/node_modules/'))
            return null;
        const ret = findParent(mod.filename, p => {
            return resolveBySource[p + '/'];
        });
        return ret;
    }

    [...finalExtensions].forEach(ext => {
        require.extensions[ext] = function(mod, file) {
            const source = resolveSource(mod);
            const orig = originalExtensions[ext] || originalExtensions['.js'];
            if (!source)
                return orig(...arguments);
            const {target, targetFile} = source.resolveTarget(file);
            if (!target)
                return orig(...arguments);
            const args = [...arguments];
            args[1] = targetFile;
            return (target.extensions[ext] || orig)(...args);
        }
    });

    // let currentResolve = null;
    const originalLookupPaths = Module._resolveLookupPaths;
    let resolving = false;
    Module._resolveLookupPaths = function(file, mod) {
        if (resolving)
            return originalLookupPaths(...arguments);
        resolving = true;
        try {
            const source = resolveSource(mod);
            if (!source)
                return originalLookupPaths(...arguments);
            
            const paths =  source.lookupPathsFor(file);
            return paths || originalLookupPaths(...arguments);
        } finally {
            resolving = false;
        }
    }
    
    Module._resolveFilename = function (file, mod) {
        const source = resolveSource(mod);
        if (!source)
            return originalResolveFilename(...arguments);
        const {target, targetFile} = source.resolveTarget(file);
        if (!target)
            return originalResolveFilename(...arguments);
        const args = [...arguments];
        args[0] = targetFile;
        try {
            return target.resolve(...args);
        } catch (e) {
            console.error('=> trying to resolve ', file);
            console.error('=> from ', mod.filename);
            console.error('=> in replacement ', source.rootResolved);
            if (targetFile !== file)
                console.error('=> modified resolution ', targetFile);
            throw e;
        }
    };

    // const oldRequire = Module.prototype.require;
    // Module.prototype.require = function (what) {
    //     return oldRequire.apply(this, arguments);
    // }


    process.chdir(oldCwd);
}

try {
    console.log('Loading multirepo...');
    register();
} catch (e) {
    console.error('Failed to load multirepo', e);
}