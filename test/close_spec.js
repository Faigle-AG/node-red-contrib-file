const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const helper = require('node-red-node-test-helper');

helper.init(require.resolve('node-red'));

const DATA_DIR = path.join(__dirname, 'data');

function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
    });
    return { promise, resolve, reject };
}

// Lets awaited continuations, fs callbacks and the helper's nextTick call events run.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

// The file nodes get their own `fs`: a facade with only the nine functions they use. Their
// filesystem calls are confined and held through it, while mocha, the test helper and Node keep
// the real fs.
const FS_OPERATIONS = [
    'readFileSync',
    'existsSync',
    'statSync',
    'mkdirSync',
    'appendFile',
    'writeFile',
    'copyFile',
    'rename',
    'unlink',
];
const CALLBACK_OPERATIONS = new Set(['appendFile', 'writeFile', 'copyFile', 'rename', 'unlink']);
// Every facade call is checked against the active test fixture. With no fixture (outside a test,
// or after a test's nodes are unloaded) it fails. Within one, a call with any path outside the
// test root is recorded and rejected before the real function runs, whatever mode is on.
let fixture = null;
const nodeFs = Object.fromEntries(
    FS_OPERATIONS.map((name) => [name, (...args) => facadeCall(name, args)]),
);

function facadeCall(name, args) {
    if (!fixture) throw new Error(`fs.${name} called outside an active test fixture`);
    const { root } = fixture;
    const paths = name === 'copyFile' || name === 'rename' ? args.slice(0, 2) : args.slice(0, 1);
    const rejected = paths
        .map((target) => path.resolve(String(target)))
        .filter((resolved) => resolved !== root && !resolved.startsWith(root + path.sep));
    if (rejected.length) {
        fixture.outside.push(`${name} ${rejected.join(' ')}`);
        throw new Error(`fs.${name} outside the test root: ${rejected.join(', ')}`);
    }
    return fixture.mode ? fixture.mode(name, args) : fs[name](...args);
}

// Confines the nodes' filesystem calls to root until endFixture(), which returns the outside
// attempts recorded meanwhile.
function startFixture(root) {
    fixture = { root, outside: [], mode: null };
}

function endFixture() {
    const outside = fixture ? fixture.outside : [];
    fixture = null;
    return outside;
}

// Loads a node module whose require('fs') returns the facade.
function loadNodeModule(file) {
    const filename = require.resolve(file);
    const mod = new Module(filename, module);
    mod.filename = filename;
    const load = Module.createRequire(filename);
    mod.require = (id) => (id === 'fs' ? nodeFs : load(id));
    mod._compile(fs.readFileSync(filename, 'utf8'), filename);
    return mod.exports;
}

const fileReadNode = loadNodeModule('../src/file-read.js');
const fileWriteNode = loadNodeModule('../src/file-write.js');
const fileTransferNode = loadNodeModule('../src/file-transfer.js');

// Adds a mode to the current fixture that counts the calls the nodes start. With `hold`, each
// callback operation runs for real but its callback waits until the test releases it, with the
// real result or an injected error. With `exdev`, rename does not run and fails as a
// cross-device rename does (EXDEV), so a move falls back to copy and unlink. Confinement stays
// on in every mode.
function instrumentFs({ hold = false, exdev = false } = {}) {
    const calls = [];
    const held = [];
    fixture.mode = (name, args) => {
        calls.push(name);
        if (exdev && name === 'rename') {
            const callback = args.pop();
            const fail = () =>
                callback(Object.assign(new Error('cross-device link'), { code: 'EXDEV' }));
            if (!hold) return setImmediate(fail);
            const release = deferred();
            held.push(release);
            release.promise.then(fail);
            return;
        }
        if (hold && CALLBACK_OPERATIONS.has(name)) {
            const callback = args.pop();
            const release = deferred();
            held.push(release);
            args.push((...result) => {
                release.promise.then((error) => callback(...(error ? [error] : result)));
            });
        }
        return fs[name](...args);
    };
    return { calls, held };
}

// Records what a node reports from the moment of the call: completions (done/_complete),
// sends (messages reaching the wired output node), statuses and errors.
function observe(node) {
    const seen = { completions: [], sends: 0, statuses: [], errors: [] };
    const complete = node._complete;
    node._complete = function (msg, err) {
        seen.completions.push(err);
        return complete.call(this, msg, err);
    };
    helper.getNode('out').on('input', () => (seen.sends += 1));
    node.on('call:status', (call) => seen.statuses.push(call.args[0]));
    node.on('call:error', (call) => seen.errors.push(call.args[0]));
    return seen;
}

function assertQuiet(seen, completions = 1) {
    assert.deepEqual(seen.completions, new Array(completions).fill(undefined));
    assert.equal(seen.sends, 0);
    assert.deepEqual(seen.statuses, []);
    assert.deepEqual(seen.errors, []);
}

// Replaces node.getTypedProperty / setTypedProperty with calls the test releases.
function holdCalls(node, method) {
    const held = [];
    node[method] = () => {
        const call = deferred();
        held.push(call);
        return call.promise;
    };
    return held;
}

// Releases held calls in order, including calls the released ones go on to make.
async function releaseAll(held, value) {
    for (let i = 0; i < held.length; i += 1) {
        held[i].resolve(typeof value === 'function' ? value(i) : value);
        await settle();
    }
}

// Loads the node under test (n1) wired to a helper output node (out).
function load(nodeModule, node) {
    const flow = [
        { id: 'n1', ...node, wires: [['out']] },
        { id: 'out', type: 'helper' },
    ];
    return new Promise((resolve) => helper.load(nodeModule, flow, resolve));
}

describe('close during in-flight work (2.8)', function () {
    this.timeout(10000);
    let root;
    let fsCalls;

    beforeEach(function (done) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        root = fs.mkdtempSync(path.join(DATA_DIR, 'close-'));
        startFixture(root);
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload().then(() =>
            helper.stopServer(() => {
                const outside = endFixture();
                fs.rmSync(root, { recursive: true, force: true });
                done(
                    outside.length ? new Error(`fs outside the test root: ${outside}`) : undefined,
                );
            }),
        );
    });

    describe('file-read', function () {
        const node = (source = 'unused') => ({
            type: 'file-read',
            source,
            sourceType: 'str',
            actionRead: true,
            actionExists: true,
            actionStat: true,
            target: 'file',
            targetType: 'msg',
        });

        it('closing while the source is read starts no read, exists or stat and completes quietly', async function () {
            const file = path.join(root, 'in.txt');
            fs.writeFileSync(file, 'data');
            await load(fileReadNode, node());
            const n1 = helper.getNode('n1');
            const reads = holdCalls(n1, 'getTypedProperty');
            fsCalls = instrumentFs();
            n1.receive({});
            await settle();
            await n1.close();
            const seen = observe(n1);
            reads[0].resolve(file);
            await settle();
            assert.deepEqual(fsCalls.calls, []);
            assertQuiet(seen);
        });

        it('a source read rejected after close completes quietly', async function () {
            await load(fileReadNode, node());
            const n1 = helper.getNode('n1');
            const reads = holdCalls(n1, 'getTypedProperty');
            n1.receive({});
            await settle();
            await n1.close();
            const seen = observe(n1);
            reads[0].reject(new Error('context store failed'));
            await settle();
            assertQuiet(seen);
        });

        it('concurrent inputs held at the source read all complete quietly after close', async function () {
            const file = path.join(root, 'in.txt');
            fs.writeFileSync(file, 'data');
            await load(fileReadNode, node());
            const n1 = helper.getNode('n1');
            const reads = holdCalls(n1, 'getTypedProperty');
            fsCalls = instrumentFs();
            n1.receive({});
            n1.receive({});
            await settle();
            assert.equal(reads.length, 2);
            await n1.close();
            const seen = observe(n1);
            await releaseAll(reads, file);
            assert.deepEqual(fsCalls.calls, []);
            assertQuiet(seen, 2);
        });

        it('closing while the target is read starts no target write and completes quietly', async function () {
            const file = path.join(root, 'in.txt');
            fs.writeFileSync(file, 'data');
            await load(fileReadNode, node());
            const n1 = helper.getNode('n1');
            const reads = holdCalls(n1, 'getTypedProperty');
            const writes = holdCalls(n1, 'setTypedProperty');
            n1.receive({});
            await settle();
            reads[0].resolve(file);
            await settle();
            assert.equal(reads.length, 2);
            await n1.close();
            const seen = observe(n1);
            reads[1].resolve({});
            await settle();
            assert.equal(writes.length, 0);
            assertQuiet(seen);
        });

        for (const outcome of ['resolves', 'rejects']) {
            it(`a target write that ${outcome} after close reports nothing`, async function () {
                const file = path.join(root, 'in.txt');
                fs.writeFileSync(file, 'data');
                await load(fileReadNode, node(file));
                const n1 = helper.getNode('n1');
                const writes = holdCalls(n1, 'setTypedProperty');
                n1.receive({});
                await settle();
                assert.equal(writes.length, 1);
                await n1.close();
                const seen = observe(n1);
                if (outcome === 'resolves') writes[0].resolve();
                else writes[0].reject(new Error('context store failed'));
                await settle();
                assertQuiet(seen);
            });
        }
    });

    describe('file-write', function () {
        const node = (action = 'write', target = 'unused') => ({
            type: 'file-write',
            action,
            target,
            targetType: 'str',
            data: 'hello',
            dataType: 'str',
            createDir: true,
        });

        it('closing while the target and data are read starts no write and completes quietly', async function () {
            const target = path.join(root, 'out', 'new.txt');
            await load(fileWriteNode, node());
            const n1 = helper.getNode('n1');
            const reads = holdCalls(n1, 'getTypedProperty');
            fsCalls = instrumentFs();
            n1.receive({});
            await settle();
            reads[0].resolve(target);
            await settle();
            assert.equal(reads.length, 2);
            await n1.close();
            const seen = observe(n1);
            reads[1].resolve('hello');
            await settle();
            assert.deepEqual(fsCalls.calls, []);
            assert.equal(fs.existsSync(path.join(root, 'out')), false);
            assertQuiet(seen);
        });

        it('a target read rejected after close completes quietly', async function () {
            await load(fileWriteNode, node());
            const n1 = helper.getNode('n1');
            const reads = holdCalls(n1, 'getTypedProperty');
            n1.receive({});
            await settle();
            await n1.close();
            const seen = observe(n1);
            reads[0].reject(new Error('context store failed'));
            await settle();
            assertQuiet(seen);
        });

        it('concurrent inputs held at the reads all complete quietly after close', async function () {
            await load(fileWriteNode, node());
            const n1 = helper.getNode('n1');
            const reads = holdCalls(n1, 'getTypedProperty');
            fsCalls = instrumentFs();
            n1.receive({});
            n1.receive({});
            await settle();
            assert.equal(reads.length, 2);
            await n1.close();
            const seen = observe(n1);
            await releaseAll(reads, (i) => (i < 2 ? path.join(root, `out-${i}.txt`) : 'hello'));
            assert.deepEqual(fsCalls.calls, []);
            assertQuiet(seen, 2);
        });

        for (const action of ['write', 'append']) {
            for (const outcome of ['succeeds', 'fails']) {
                it(`${action === 'append' ? 'an' : 'a'} ${action} whose callback ${outcome} after close reports nothing`, async function () {
                    await load(fileWriteNode, node(action, path.join(root, 'out.txt')));
                    const n1 = helper.getNode('n1');
                    fsCalls = instrumentFs({ hold: true });
                    n1.receive({});
                    await settle();
                    assert.equal(fsCalls.held.length, 1);
                    await n1.close();
                    const seen = observe(n1);
                    fsCalls.held[0].resolve(
                        outcome === 'fails' ? new Error('disk failed') : undefined,
                    );
                    await settle();
                    assertQuiet(seen);
                });
            }
        }
    });

    describe('file-transfer', function () {
        const node = (action, source = 'unused', destination = 'unused') => ({
            type: 'file-transfer',
            action,
            source,
            sourceType: 'str',
            destination,
            destinationType: 'str',
            createDir: true,
        });

        it('closing while the paths are read starts no copy and completes quietly', async function () {
            const source = path.join(root, 'in.txt');
            fs.writeFileSync(source, 'data');
            await load(fileTransferNode, node('copy'));
            const n1 = helper.getNode('n1');
            const reads = holdCalls(n1, 'getTypedProperty');
            fsCalls = instrumentFs();
            n1.receive({});
            await settle();
            reads[0].resolve(source);
            await settle();
            assert.equal(reads.length, 2);
            await n1.close();
            const seen = observe(n1);
            reads[1].resolve(path.join(root, 'out', 'copy.txt'));
            await settle();
            assert.deepEqual(fsCalls.calls, []);
            assert.equal(fs.existsSync(path.join(root, 'out')), false);
            assertQuiet(seen);
        });

        it('a path read rejected after close completes quietly', async function () {
            await load(fileTransferNode, node('copy'));
            const n1 = helper.getNode('n1');
            const reads = holdCalls(n1, 'getTypedProperty');
            n1.receive({});
            await settle();
            await n1.close();
            const seen = observe(n1);
            reads[0].reject(new Error('context store failed'));
            await settle();
            assertQuiet(seen);
        });

        it('concurrent inputs held at the path reads all complete quietly after close', async function () {
            const source = path.join(root, 'in.txt');
            fs.writeFileSync(source, 'data');
            await load(fileTransferNode, node('copy'));
            const n1 = helper.getNode('n1');
            const reads = holdCalls(n1, 'getTypedProperty');
            fsCalls = instrumentFs();
            n1.receive({});
            n1.receive({});
            await settle();
            assert.equal(reads.length, 2);
            await n1.close();
            const seen = observe(n1);
            await releaseAll(reads, (i) => (i < 2 ? source : path.join(root, `copy-${i}.txt`)));
            assert.deepEqual(fsCalls.calls, []);
            assertQuiet(seen, 2);
        });

        // Copy, a same-device move and delete; the cross-device move follows below.
        for (const action of ['copy', 'move', 'delete']) {
            for (const outcome of ['succeeds', 'fails']) {
                it(`a ${action} whose callback ${outcome} after close reports nothing`, async function () {
                    const source = path.join(root, 'in.txt');
                    fs.writeFileSync(source, 'data');
                    await load(fileTransferNode, node(action, source, path.join(root, 'out.txt')));
                    const n1 = helper.getNode('n1');
                    fsCalls = instrumentFs({ hold: true });
                    n1.receive({});
                    await settle();
                    assert.equal(fsCalls.held.length, 1);
                    await n1.close();
                    const seen = observe(n1);
                    fsCalls.held[0].resolve(
                        outcome === 'fails' ? new Error('disk failed') : undefined,
                    );
                    await settle();
                    assertQuiet(seen);
                });
            }
        }

        // Cross-device move (EXDEV): rename fails, so the node copies and then removes the source.
        // After close it starts no next step and completes with an error, without status.
        async function startMove(destinationContent) {
            const source = path.join(root, 'in.txt');
            const destination = path.join(root, 'out.txt');
            fs.writeFileSync(source, 'data');
            if (destinationContent !== undefined) fs.writeFileSync(destination, destinationContent);
            await load(fileTransferNode, node('move', source, destination));
            fsCalls = instrumentFs({ hold: true, exdev: true });
            helper.getNode('n1').receive({});
            await settle();
            assert.deepEqual(fsCalls.calls.slice(-1), ['rename']);
            return { n1: helper.getNode('n1'), source, destination };
        }

        // One error completion, no output and no status.
        function assertStoppedWithError(seen, check) {
            assert.equal(seen.completions.length, 1);
            check(seen.completions[0]);
            assert.equal(seen.sends, 0);
            assert.deepEqual(seen.statuses, []);
        }
        const nodeClosing = (err) => assert.equal(err && err.code, 'NODE_CLOSING');

        it('a cross-device move closed before its copy copies nothing, keeps the source and fails with NODE_CLOSING', async function () {
            const { n1, source, destination } = await startMove();
            await n1.close();
            const seen = observe(n1);
            fsCalls.held[0].resolve();
            await settle();
            assert.equal(fsCalls.calls.includes('copyFile'), false);
            assert.equal(fs.existsSync(source), true);
            assert.equal(fs.readFileSync(source, 'utf8'), 'data');
            assert.equal(fs.existsSync(destination), false);
            assertStoppedWithError(seen, nodeClosing);
        });

        it('a cross-device move closed after its copy removes nothing, keeps the copy and fails with NODE_CLOSING', async function () {
            const { n1, source, destination } = await startMove();
            fsCalls.held[0].resolve();
            await settle();
            assert.equal(fsCalls.held.length, 2);
            await n1.close();
            const seen = observe(n1);
            fsCalls.held[1].resolve();
            await settle();
            assert.equal(fsCalls.calls.includes('unlink'), false);
            assert.equal(fs.existsSync(source), true);
            assert.equal(fs.readFileSync(source, 'utf8'), 'data');
            assert.equal(fs.readFileSync(destination, 'utf8'), 'data');
            assertStoppedWithError(seen, nodeClosing);
        });

        it('a cross-device move closed after its copy has replaced an existing destination and fails with NODE_CLOSING', async function () {
            const { n1, source, destination } = await startMove('old');
            fsCalls.held[0].resolve();
            await settle();
            await n1.close();
            const seen = observe(n1);
            fsCalls.held[1].resolve();
            await settle();
            assert.equal(fs.existsSync(source), true);
            assert.equal(fs.readFileSync(source, 'utf8'), 'data');
            assert.equal(fs.readFileSync(destination, 'utf8'), 'data');
            assertStoppedWithError(seen, nodeClosing);
        });

        it('a cross-device copy that fails after close removes nothing and fails with the copy error', async function () {
            const { n1, source } = await startMove();
            fsCalls.held[0].resolve();
            await settle();
            await n1.close();
            const seen = observe(n1);
            const copyError = new Error('disk failed');
            fsCalls.held[1].resolve(copyError);
            await settle();
            assert.equal(fsCalls.calls.includes('unlink'), false);
            assert.equal(fs.existsSync(source), true);
            assert.equal(fs.readFileSync(source, 'utf8'), 'data');
            assertStoppedWithError(seen, (err) => assert.equal(err, copyError));
        });

        // Control: passes before and after the change.
        it('a cross-device move with no close copies, removes the source and reports once', async function () {
            const source = path.join(root, 'in.txt');
            const destination = path.join(root, 'out.txt');
            fs.writeFileSync(source, 'data');
            await load(fileTransferNode, node('move', source, destination));
            const n1 = helper.getNode('n1');
            const seen = observe(n1);
            fsCalls = instrumentFs({ exdev: true });
            n1.receive({});
            await settle();
            assert.deepEqual(
                fsCalls.calls.filter((name) => name !== 'existsSync'),
                ['rename', 'copyFile', 'unlink'],
            );
            assert.equal(fs.existsSync(source), false);
            assert.equal(fs.readFileSync(destination, 'utf8'), 'data');
            assert.equal(seen.sends, 1);
            assert.deepEqual(seen.completions, [undefined]);
        });
    });
});

describe('fs facade (fixture controls)', function () {
    // Spies stand in for the real functions, so these controls perform no filesystem I/O.
    const root = path.join(DATA_DIR, 'guard-root');
    const outsidePath = path.join(DATA_DIR, 'outside');
    const argsFor = (name, target) =>
        name === 'copyFile' || name === 'rename'
            ? [path.join(root, 'in'), target, () => {}]
            : [target, () => {}];
    let real;
    let spyCalls;

    beforeEach(function () {
        real = {};
        spyCalls = {};
        for (const name of FS_OPERATIONS) {
            real[name] = fs[name];
            spyCalls[name] = 0;
            fs[name] = () => (spyCalls[name] += 1);
        }
    });

    afterEach(function () {
        endFixture();
        Object.assign(fs, real);
    });

    it('with no active fixture, a node fs call fails and never reaches the real function', function () {
        for (const name of FS_OPERATIONS) {
            assert.throws(
                () => nodeFs[name](...argsFor(name, path.join(root, 'x'))),
                /outside an active test fixture/,
            );
            assert.equal(spyCalls[name], 0, name);
        }
    });

    it('within a fixture, a call with any path outside the root is rejected before the real function runs', function () {
        startFixture(root);
        for (const name of FS_OPERATIONS) {
            assert.throws(
                () => nodeFs[name](...argsFor(name, outsidePath)),
                /outside the test root/,
            );
            assert.equal(spyCalls[name], 0, name);
        }
        nodeFs.mkdirSync(path.join(root, 'inside'));
        assert.equal(spyCalls.mkdirSync, 1);
        assert.equal(endFixture().length, FS_OPERATIONS.length);
        // The fs that mocha, the test helper and Node use is not confined.
        assert.doesNotThrow(() => fs.existsSync(outsidePath));
    });

    it('a counting mode keeps confinement, and confinement and its records stay after the mode ends', function () {
        startFixture(root);
        const counted = instrumentFs();
        assert.throws(() => nodeFs.unlink(outsidePath, () => {}), /outside the test root/);
        nodeFs.existsSync(path.join(root, 'inside'));
        assert.deepEqual(counted.calls, ['existsSync']);
        fixture.mode = null;
        assert.throws(() => nodeFs.readFileSync(outsidePath), /outside the test root/);
        assert.equal(spyCalls.unlink + spyCalls.readFileSync, 0);
        assert.equal(endFixture().length, 2);
        assert.throws(
            () => nodeFs.existsSync(path.join(root, 'inside')),
            /outside an active test fixture/,
        );
    });
});
