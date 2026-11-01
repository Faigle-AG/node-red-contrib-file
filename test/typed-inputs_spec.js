'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const helper = require('node-red-node-test-helper');

helper.init(require.resolve('node-red'));

// Phase 2.9: the typed fields of the file nodes. T1 pins what each editor offers, T2 checks that
// each runtime allows exactly those types, T3 evaluates every offered type, T4 rejects any other
// type before the filesystem is touched, T5 pins the defaults of flows saved without the fields,
// and T6 pins what the new file-write data types write.

const SRC = path.join(__dirname, '../src');
const RUN_ID = process.env.TEST_RUN_ID || `${Date.now()}-${process.pid}`;
const ROOT = path.join(__dirname, 'data', 'typed-inputs', RUN_ID);

const VALUE = ['msg', 'flow', 'global', 'str', 'jsonata', 'env'];
const TARGET = ['msg', 'flow', 'global'];
const DATA = ['msg', 'flow', 'global', 'str', 'json', 'bin', 'jsonata', 'env'];

// What each editor offers: the types in order, the selected default type, and the saved defaults
// of the value and of its type field.
const EDITORS = {
    'file-read.html': {
        'file-read': {
            source: { types: VALUE, default: 'str', value: '', type: 'str' },
            target: { types: TARGET, default: 'msg', value: 'file', type: 'msg' },
        },
    },
    'file-write.html': {
        'file-write': {
            target: { types: VALUE, default: 'str', value: '', type: 'str' },
            data: { types: DATA, default: 'msg', value: 'file.data', type: 'msg' },
        },
    },
    'file-transfer.html': {
        'file-transfer': {
            source: { types: VALUE, default: 'str', value: '', type: 'str' },
            destination: { types: VALUE, default: 'str', value: '', type: 'str' },
        },
    },
};

// Runs an editor's registration script and its oneditprepare against a recording jQuery stub, and
// returns the registered definition and every typedInput it creates, by field.
function loadEditor(file, nodeType) {
    const html = fs.readFileSync(path.join(SRC, file), 'utf8');
    const registered = new Map();
    const inputs = {};
    const element = (selector) =>
        new Proxy(function () {}, {
            get(target, prop) {
                if (prop === 'selector') return selector;
                if (prop === 'typedInput') {
                    return (options) => {
                        inputs[selector.replace('#node-input-', '')] = {
                            // Copied into this realm: the editor script runs in its own.
                            types: Array.from(options.types),
                            default: options.default,
                            typeField: options.typeField && options.typeField.selector,
                        };
                        return element(selector);
                    };
                }
                if (prop === 'val') return () => '';
                if (prop === 'prop' || prop === 'is') return () => false;
                return () => element(selector);
            },
            apply: () => element(selector),
        });
    const anything = () =>
        new Proxy(function () {}, { get: () => anything(), apply: () => anything() });
    const RED = {
        nodes: { registerType: (type, definition) => registered.set(type, definition) },
        validators: anything(),
        _: (key) => key,
    };
    for (const [, source] of html.matchAll(/<script type="text\/javascript">([\s\S]*?)<\/script>/g))
        vm.runInNewContext(source, { RED, $: (selector) => element(String(selector)) });
    const definition = registered.get(nodeType);
    const self = Object.fromEntries(
        Object.entries(definition.defaults).map(([key, spec]) => [key, spec.value]),
    );
    definition.oneditprepare.call(self);
    return { definition, inputs };
}

// The file nodes get their own `fs`: a facade with only the nine functions they use, as in
// close_spec.js. Every facade call is checked against the active test fixture. With no fixture
// (outside a test, or after a test's nodes are unloaded, as for a late continuation) it fails.
// Within one, a call with any path outside the case root is recorded and rejected before the real
// function runs, whether or not the test counts calls.
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
    if (fixture.calls) fixture.calls.push(name);
    return fs[name](...args);
}

// Confines the nodes' filesystem calls to root until endFixture(), which returns the outside
// attempts recorded meanwhile.
function startFixture(root) {
    fixture = { root, outside: [], calls: null };
}

function endFixture() {
    const outside = fixture ? fixture.outside : [];
    fixture = null;
    return outside;
}

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

const RUNTIME = {
    'file-read': fileReadNode.TYPES,
    'file-write': fileWriteNode.TYPES,
    'file-transfer': fileTransferNode.TYPES,
};

// Sends one message and resolves with the output message or the error it completes with.
function run(node, msg) {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ timeout: true }), 1500);
        helper.getNode('out').once('input', (out) => {
            clearTimeout(timer);
            resolve({ msg: out });
        });
        node.once('call:error', (call) => {
            clearTimeout(timer);
            resolve({ err: call.args[0] });
        });
        node.receive(msg);
    });
}

describe('typed inputs (Phase 2.9)', function () {
    this.timeout(10000);

    after(function () {
        fs.rmSync(ROOT, { recursive: true, force: true });
    });

    describe('T1 editor pins and T2 runtime parity', function () {
        for (const [file, nodes] of Object.entries(EDITORS)) {
            for (const [nodeType, fields] of Object.entries(nodes)) {
                describe(nodeType, function () {
                    const { definition, inputs } = loadEditor(file, nodeType);

                    it('creates exactly the expected typed inputs', function () {
                        assert.deepEqual(Object.keys(inputs).sort(), Object.keys(fields).sort());
                    });

                    for (const [field, expected] of Object.entries(fields)) {
                        it(`${field}: offered types, default type, type field and saved defaults`, function () {
                            assert.deepEqual(inputs[field].types, expected.types);
                            assert.equal(inputs[field].default, expected.default);
                            assert.equal(inputs[field].typeField, `#node-input-${field}Type`);
                            assert.equal(definition.defaults[field].value, expected.value);
                            assert.equal(definition.defaults[`${field}Type`].value, expected.type);
                        });

                        it(`${field}: the runtime allows exactly the offered types`, function () {
                            assert.deepEqual(
                                [...RUNTIME[nodeType][field]].sort(),
                                [...expected.types].sort(),
                            );
                        });
                    }
                });
            }
        }
    });

    describe('runtime', function () {
        let root;

        beforeEach(function (done) {
            root = path.join(ROOT, `case-${Math.random().toString(36).slice(2)}`);
            fs.mkdirSync(root, { recursive: true });
            fs.writeFileSync(path.join(root, 'a.txt'), 'a');
            startFixture(root);
            helper.startServer(done);
        });

        afterEach(function (done) {
            delete process.env.TYPED_29_VALUE;
            helper.unload().then(() =>
                helper.stopServer(() => {
                    // Only now, after unload: any later filesystem call of these nodes is refused.
                    const outside = endFixture();
                    fs.rmSync(root, { recursive: true, force: true });
                    done(
                        outside.length
                            ? new Error(`fs outside the test root: ${outside}`)
                            : undefined,
                    );
                }),
            );
        });

        const wired = (node) => [
            { id: 'f1', type: 'tab' },
            { ...node, id: 'n1', z: 'f1', wires: [['out']] },
            { id: 'out', type: 'helper', z: 'f1' },
        ];

        // A configured value of each offered type that resolves to `value`, given msg.p, flow and
        // global p, and the environment variable.
        function representative(type, value) {
            process.env.TYPED_29_VALUE = value;
            return {
                msg: ['p', { p: value }],
                flow: ['p', {}],
                global: ['p', {}],
                str: [value, {}],
                jsonata: ['p', { p: value }],
                env: ['TYPED_29_VALUE', {}],
            }[type];
        }

        async function load(module, node, value) {
            await helper.load(module, wired(node));
            const n1 = helper.getNode('n1');
            n1.context().flow.set('p', value);
            n1.context().global.set('p', value);
            return n1;
        }

        describe('T3 every offered type works', function () {
            for (const type of VALUE) {
                it(`file-read source of type ${type} reads the file`, async function () {
                    const file = path.join(root, 'a.txt');
                    const [source, msg] = representative(type, file);
                    const n1 = await load(
                        fileReadNode,
                        { type: 'file-read', source, sourceType: type, actionRead: true },
                        file,
                    );
                    const result = await run(n1, msg);
                    assert.equal(String(result.msg.file.data), 'a');
                });

                it(`file-write target of type ${type} writes the file`, async function () {
                    const file = path.join(root, 'written.txt');
                    const [target, msg] = representative(type, file);
                    const n1 = await load(
                        fileWriteNode,
                        {
                            type: 'file-write',
                            action: 'write',
                            target,
                            targetType: type,
                            data: 'text',
                            dataType: 'str',
                        },
                        file,
                    );
                    const result = await run(n1, msg);
                    assert.ok(result.msg, `written: ${result.err && result.err.message}`);
                    assert.equal(fs.readFileSync(file, 'utf8'), 'text');
                });

                for (const field of ['source', 'destination']) {
                    it(`file-transfer ${field} of type ${type} copies the file`, async function () {
                        const from = path.join(root, 'a.txt');
                        const to = path.join(root, 'copied.txt');
                        const value = field === 'source' ? from : to;
                        const [configured, msg] = representative(type, value);
                        const n1 = await load(
                            fileTransferNode,
                            {
                                type: 'file-transfer',
                                action: 'copy',
                                source: field === 'source' ? configured : from,
                                sourceType: field === 'source' ? type : 'str',
                                destination: field === 'destination' ? configured : to,
                                destinationType: field === 'destination' ? type : 'str',
                            },
                            value,
                        );
                        const result = await run(n1, msg);
                        assert.ok(result.msg, `copied: ${result.err && result.err.message}`);
                        assert.equal(fs.readFileSync(to, 'utf8'), 'a');
                    });
                }
            }

            for (const type of DATA) {
                it(`file-write data of type ${type} writes its value`, async function () {
                    const file = path.join(root, 'written.txt');
                    const values = {
                        json: ['{"k":[1,2]}', '{"k":[1,2]}'],
                        bin: ['[104,105]', 'hi'],
                    };
                    const [configured, msg] = values[type]
                        ? [values[type][0], {}]
                        : representative(type, 'text');
                    const n1 = await load(
                        fileWriteNode,
                        {
                            type: 'file-write',
                            action: 'write',
                            target: file,
                            targetType: 'str',
                            data: configured,
                            dataType: type,
                        },
                        'text',
                    );
                    const result = await run(n1, msg);
                    assert.ok(result.msg, `written: ${result.err && result.err.message}`);
                    assert.equal(
                        fs.readFileSync(file, 'utf8'),
                        values[type] ? values[type][1] : 'text',
                    );
                });
            }

            for (const type of TARGET) {
                it(`file-read target of type ${type} receives the file`, async function () {
                    const file = path.join(root, 'a.txt');
                    const n1 = await load(
                        fileReadNode,
                        {
                            type: 'file-read',
                            source: file,
                            sourceType: 'str',
                            actionRead: true,
                            target: 'out',
                            targetType: type,
                        },
                        file,
                    );
                    const result = await run(n1, {});
                    const written = type === 'msg' ? result.msg.out : n1.context()[type].get('out');
                    assert.equal(String(written.data), 'a');
                });
            }
        });

        describe('T4 any other type fails before the filesystem is touched', function () {
            const cases = [
                ['file-read', fileReadNode, 'source', { actionRead: true, target: 'file' }],
                [
                    'file-write',
                    fileWriteNode,
                    'target',
                    { action: 'write', data: 'x', dataType: 'str' },
                ],
                [
                    'file-write',
                    fileWriteNode,
                    'data',
                    { action: 'write', target: 'w.txt', targetType: 'str' },
                ],
                [
                    'file-transfer',
                    fileTransferNode,
                    'source',
                    { action: 'copy', destination: 'c.txt', destinationType: 'str' },
                ],
                [
                    'file-transfer',
                    fileTransferNode,
                    'destination',
                    { action: 'copy', source: 'a.txt', sourceType: 'str' },
                ],
            ];
            for (const [nodeType, module, field, rest] of cases) {
                for (const type of ['num', 'foo']) {
                    it(`${nodeType} ${field} of type ${type}`, async function () {
                        const node = {
                            type: nodeType,
                            ...rest,
                            [field]: 'a.txt',
                            [`${field}Type`]: type,
                        };
                        // Every path, the checked one included, is inside the case root: code
                        // without the check then fails these assertions instead of the fence.
                        for (const key of ['source', 'target', 'destination']) {
                            if (typeof node[key] === 'string')
                                node[key] = path.join(root, node[key]);
                        }
                        await helper.load(module, wired(node));
                        fixture.calls = [];
                        const result = await run(helper.getNode('n1'), {});
                        const label = field[0].toUpperCase() + field.slice(1);
                        assert.equal(result.err.code, 'INVALID_CONFIGURATION');
                        assert.equal(
                            result.err.message,
                            `${label} type '${type}' is not supported`,
                        );
                        assert.deepEqual(fixture.calls, []);
                    });
                }
            }

            for (const type of ['str', 'foo']) {
                it(`file-read target of type ${type} fails with the setter's message, before reading`, async function () {
                    await helper.load(
                        fileReadNode,
                        wired({
                            type: 'file-read',
                            source: path.join(root, 'a.txt'),
                            sourceType: 'str',
                            actionRead: true,
                            target: 'out',
                            targetType: type,
                        }),
                    );
                    fixture.calls = [];
                    const result = await run(helper.getNode('n1'), {});
                    assert.equal(result.err.code, undefined);
                    assert.equal(result.err.message, `Unsupported target property type: ${type}`);
                    assert.deepEqual(fixture.calls, []);
                });
            }

            it('the static fields of dynamic nodes are not checked', async function () {
                await helper.load(
                    fileWriteNode,
                    wired({
                        type: 'file-write',
                        dynamic: true,
                        targetType: 'foo',
                        dataType: 'foo',
                    }),
                );
                const file = path.join(root, 'dynamic.txt');
                const result = await run(helper.getNode('n1'), {
                    file: { action: 'write', path: file, data: 'dynamic' },
                });
                assert.ok(result.msg, `written: ${result.err && result.err.message}`);
                assert.equal(fs.readFileSync(file, 'utf8'), 'dynamic');
            });

            it('the static source of a dynamic file-read is not checked', async function () {
                await helper.load(
                    fileReadNode,
                    wired({ type: 'file-read', dynamic: true, sourceType: 'foo' }),
                );
                const result = await run(helper.getNode('n1'), {
                    file: { action: 'read', path: path.join(root, 'a.txt') },
                });
                assert.equal(String(result.msg.file.data), 'a');
            });

            it('the static paths of a dynamic file-transfer are not checked', async function () {
                await helper.load(
                    fileTransferNode,
                    wired({
                        type: 'file-transfer',
                        dynamic: true,
                        sourceType: 'foo',
                        destinationType: 'foo',
                    }),
                );
                const to = path.join(root, 'copied.txt');
                const result = await run(helper.getNode('n1'), {
                    file: { action: 'copy', source: path.join(root, 'a.txt'), destination: to },
                });
                assert.ok(result.msg, `copied: ${result.err && result.err.message}`);
                assert.equal(fs.readFileSync(to, 'utf8'), 'a');
            });

            it('a delete does not check the destination it never uses', async function () {
                await helper.load(
                    fileTransferNode,
                    wired({
                        type: 'file-transfer',
                        action: 'delete',
                        source: path.join(root, 'a.txt'),
                        sourceType: 'str',
                        destinationType: 'foo',
                    }),
                );
                const result = await run(helper.getNode('n1'), {});
                assert.ok(result.msg, `deleted: ${result.err && result.err.message}`);
                assert.equal(fs.existsSync(path.join(root, 'a.txt')), false);
            });
        });

        describe('T5 flows saved without the typed fields', function () {
            it('file-write defaults to a string target and msg.file.data', async function () {
                const file = path.join(root, 'legacy.txt');
                await helper.load(
                    fileWriteNode,
                    wired({ type: 'file-write', action: 'write', target: file }),
                );
                const result = await run(helper.getNode('n1'), { file: { data: 'legacy' } });
                assert.ok(result.msg, `written: ${result.err && result.err.message}`);
                assert.equal(fs.readFileSync(file, 'utf8'), 'legacy');
            });

            it('file-read defaults to a string source and msg.file', async function () {
                await helper.load(
                    fileReadNode,
                    wired({
                        type: 'file-read',
                        source: path.join(root, 'a.txt'),
                        actionRead: true,
                    }),
                );
                const result = await run(helper.getNode('n1'), {});
                assert.equal(String(result.msg.file.data), 'a');
            });

            it('file-transfer defaults to string paths', async function () {
                const to = path.join(root, 'copied.txt');
                await helper.load(
                    fileTransferNode,
                    wired({
                        type: 'file-transfer',
                        action: 'copy',
                        source: path.join(root, 'a.txt'),
                        destination: to,
                    }),
                );
                const result = await run(helper.getNode('n1'), {});
                assert.ok(result.msg, `copied: ${result.err && result.err.message}`);
            });
        });

        describe('T6 what file-write writes for each kind of data', function () {
            async function write(dataType, data, msg = {}) {
                const file = path.join(root, `t6-${Math.random().toString(36).slice(2)}.txt`);
                await helper.load(
                    fileWriteNode,
                    wired({
                        type: 'file-write',
                        action: 'write',
                        target: file,
                        targetType: 'str',
                        data,
                        dataType,
                    }),
                );
                const result = await run(helper.getNode('n1'), msg);
                return { result, bytes: fs.existsSync(file) ? fs.readFileSync(file) : null };
            }

            it('a JSON object literal is written as its JSON text', async function () {
                const { bytes } = await write('json', '{"a":1,"b":"two"}');
                assert.equal(String(bytes), '{"a":1,"b":"two"}');
            });

            it('a JSON array literal is written as its JSON text', async function () {
                const { bytes } = await write('json', '[1, "x"]');
                assert.equal(String(bytes), '[1,"x"]');
            });

            it('a JSON string literal is written as the plain string', async function () {
                const { bytes } = await write('json', '"plain"');
                assert.equal(String(bytes), 'plain');
            });

            it('a bin literal is written as its bytes', async function () {
                const { bytes } = await write('bin', '[0,255,104]');
                assert.deepEqual([...bytes], [0, 255, 104]);
            });

            it('a Buffer from msg is written unchanged', async function () {
                const { bytes } = await write('msg', 'p', { p: Buffer.from([1, 2, 3]) });
                assert.deepEqual([...bytes], [1, 2, 3]);
            });

            // A number or boolean is not converted to text: fs rejects it at the write, whichever
            // type supplies it. A string is written as it is (above).
            it('a JSON number literal fails at the write, as a number from msg does', async function () {
                const { result, bytes } = await write('json', '5');
                assert.equal(result.err.code, 'ERR_INVALID_ARG_TYPE');
                assert.equal(bytes, null);
            });

            it('a number from msg fails at the write (control)', async function () {
                const { result, bytes } = await write('msg', 'p', { p: 5 });
                assert.equal(result.err.code, 'ERR_INVALID_ARG_TYPE');
                assert.equal(bytes, null);
            });

            it('a JSON boolean literal fails at the write', async function () {
                const { result, bytes } = await write('json', 'true');
                assert.equal(result.err.code, 'ERR_INVALID_ARG_TYPE');
                assert.equal(bytes, null);
            });

            // The property helper turns a null or undefined result into '', so an empty file is
            // written rather than the text "null".
            it('a JSON null literal writes an empty file', async function () {
                const { result, bytes } = await write('json', 'null');
                assert.equal(result.err, undefined);
                assert.equal(String(bytes), '');
            });
        });
    });

    describe('fs facade (fixture controls)', function () {
        // Spies stand in for the real functions, so these controls perform no filesystem I/O.
        const root = path.join(ROOT, 'case-a');
        const otherCase = path.join(ROOT, 'case-b', 'x');
        const outsidePath = path.join(__dirname, 'outside');
        const twoPaths = (name) => name === 'copyFile' || name === 'rename';
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
                const inside = path.join(root, 'x');
                const args = twoPaths(name) ? [inside, path.join(root, 'y')] : [inside];
                assert.throws(() => nodeFs[name](...args), /outside an active test fixture/);
                assert.equal(spyCalls[name], 0, name);
            }
        });

        it("within a fixture, another case's root and the run outside it are rejected", function () {
            startFixture(root);
            for (const name of FS_OPERATIONS) {
                for (const target of [otherCase, outsidePath]) {
                    const args = twoPaths(name) ? [target, path.join(root, 'y')] : [target];
                    assert.throws(() => nodeFs[name](...args), /outside the test root/);
                }
                assert.equal(spyCalls[name], 0, name);
            }
            nodeFs.mkdirSync(path.join(root, 'inside'));
            assert.equal(spyCalls.mkdirSync, 1);
            assert.equal(endFixture().length, 2 * FS_OPERATIONS.length);
        });

        it('copy and move check both endpoints, and counting keeps confinement', function () {
            startFixture(root);
            fixture.calls = [];
            const inside = path.join(root, 'in');
            for (const name of ['copyFile', 'rename']) {
                assert.throws(() => nodeFs[name](inside, otherCase), /outside the test root/);
                assert.throws(() => nodeFs[name](outsidePath, inside), /outside the test root/);
            }
            nodeFs.copyFile(inside, path.join(root, 'out'));
            assert.equal(spyCalls.rename, 0);
            assert.equal(spyCalls.copyFile, 1);
            assert.deepEqual(fixture.calls, ['copyFile']);
            assert.equal(endFixture().length, 4);
            assert.throws(() => nodeFs.readFileSync(inside), /outside an active test fixture/);
        });
    });
});
