const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const helper = require('node-red-node-test-helper');
const fileReadNode = require('../src/file-read.js');
const fileWriteNode = require('../src/file-write.js');
const fileTransferNode = require('../src/file-transfer.js');
const catchNode = require('@node-red/nodes/core/common/25-catch.js');
const { trigger, lastStatusText } = require('./helpers/harness');

helper.init(require.resolve('node-red'));

const DATA_DIR = path.join(__dirname, 'data');

// Characterization of current local file-node behavior (Phase 2.2a), pinned before
// storage harmonization. Tests titled "legacy:" pin quirks that differ from the Azure
// nodes or the proposed contract; a later change must alter them deliberately.
describe('file nodes characterization', function () {
    let workDir;

    function load(type, nodeConfig, extraNodes = []) {
        const flow = [
            { id: 'f1', type: 'tab' },
            { id: 'n1', z: 'f1', type, wires: [['out']], ...nodeConfig },
            { id: 'out', z: 'f1', type: 'helper' },
            ...extraNodes.map((node) => ({ z: 'f1', ...node })),
        ];
        return helper.load([fileReadNode, fileWriteNode, fileTransferNode, catchNode], flow);
    }

    function work(...segments) {
        return path.join(workDir, ...segments);
    }

    beforeEach(function (done) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        workDir = fs.mkdtempSync(path.join(DATA_DIR, 'characterization-'));
        fs.writeFileSync(work('a.txt'), 'alpha');
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(function () {
            fs.rmSync(workDir, { recursive: true, force: true });
            done();
        });
    });

    describe('file-read', function () {
        it('legacy: string actions match by substring', async function () {
            await load('file-read', { dynamic: true });

            const bread = await trigger(helper, 'n1', 'out', {
                file: { action: 'bread', path: work('a.txt') },
            });
            assert.equal(bread.msg.file.data.toString(), 'alpha');

            const status = await trigger(helper, 'n1', 'out', {
                file: { action: 'status', path: work('a.txt') },
            });
            assert.ok(status.msg.file.stats.isFile());
        });

        it('legacy: array actions are case-sensitive; flag objects are truthy', async function () {
            await load('file-read', { dynamic: true });

            const upper = await trigger(helper, 'n1', 'out', {
                file: { action: ['READ'], path: work('a.txt') },
            });
            assert.equal(upper.msg.file.data, undefined);
            assert.equal(lastStatusText(upper), 'Did nothing to the file...');

            const truthy = await trigger(helper, 'n1', 'out', {
                file: { action: { read: 'yes' }, path: work('a.txt') },
            });
            assert.equal(truthy.msg.file.data.toString(), 'alpha');
        });

        it('legacy: read and stat of a missing file fail with native ENOENT', async function () {
            await load('file-read', { dynamic: true });

            for (const action of ['read', 'stat', ['read', 'exists']]) {
                const result = await trigger(helper, 'n1', 'out', {
                    file: { action, path: work('missing.txt') },
                });
                assert.equal(result.err.code, 'ENOENT', JSON.stringify(action));
                assert.equal(lastStatusText(result), 'ENOENT');
            }
        });

        it('legacy: validation errors carry no code and show the message as status', async function () {
            await load('file-read', { actionRead: true, source: '' });
            const noSource = await trigger(helper, 'n1', 'out', {});
            assert.equal(noSource.err.code, undefined);
            assert.equal(noSource.err.message, 'Source path is missing');
            assert.equal(lastStatusText(noSource), 'Source path is missing');

            helper.unload();
            await load('file-read', { dynamic: true });
            const noAction = await trigger(helper, 'n1', 'out', { file: { path: 'x' } });
            assert.equal(noAction.err.code, undefined);
            assert.equal(
                noAction.err.message,
                'Dynamic action requested but msg.file.action is missing',
            );
        });

        it('legacy: resolves dot segments with path.normalize instead of rejecting them', async function () {
            await load('file-read', { actionRead: true, source: work('sub', '..', 'a.txt') });

            const result = await trigger(helper, 'n1', 'out', {});

            assert.equal(result.msg.file.path, work('a.txt'));
            assert.equal(result.msg.file.data.toString(), 'alpha');
        });

        it('legacy: a string msg.file target is spread into indexed characters', async function () {
            await load('file-read', { actionExists: true, source: work('a.txt') });

            const result = await trigger(helper, 'n1', 'out', { file: 'ab' });

            assert.equal(result.msg.file[0], 'a');
            assert.equal(result.msg.file[1], 'b');
            assert.equal(result.msg.file.exists, true);
        });

        it('exposes native codes to Catch nodes and omits code for validation errors', async function () {
            await load('file-read', { dynamic: true }, [
                { id: 'c1', type: 'catch', scope: null, uncaught: false, wires: [['caught']] },
                { id: 'caught', type: 'helper' },
            ]);
            const caught = [];
            helper.getNode('caught').on('input', (msg) => caught.push(msg));

            helper.getNode('n1').receive({ file: { action: 'read', path: work('missing') } });
            helper.getNode('n1').receive({ file: { path: work('a.txt') } });
            await new Promise((resolve) => setTimeout(resolve, 100));

            assert.equal(caught.length, 2);
            const codes = caught.map((msg) => msg.error.code);
            assert.ok(codes.includes('ENOENT'));
            assert.ok(codes.includes(undefined));
        });
    });

    describe('file-write', function () {
        it('merges metadata into msg.file and leaves msg.payload untouched', async function () {
            await load('file-write', { action: 'write', target: work('out.txt') });

            const result = await trigger(helper, 'n1', 'out', {
                payload: 'untouched',
                file: { data: 'hello', custom: 1 },
            });

            assert.equal(fs.readFileSync(work('out.txt'), 'utf8'), 'hello');
            assert.equal(result.msg.payload, 'untouched');
            assert.equal(result.msg.file.custom, 1);
            assert.equal(result.msg.file.base, 'out.txt');
            assert.equal(lastStatusText(result), 'Wrote out.txt');
        });

        it('legacy: static data with msg.file but no data writes an empty file', async function () {
            await load('file-write', { action: 'write', target: work('empty.txt') });

            const result = await trigger(helper, 'n1', 'out', { file: {} });

            assert.ok(result.msg);
            assert.equal(fs.readFileSync(work('empty.txt'), 'utf8'), '');
        });

        it('legacy: static data without msg.file fails with an uncoded TypeError', async function () {
            await load('file-write', { action: 'write', target: work('none.txt') });

            const result = await trigger(helper, 'n1', 'out', {});

            assert.ok(result.err instanceof TypeError);
            assert.equal(result.err.code, undefined);
            assert.equal(lastStatusText(result), 'Configuration error');
            assert.equal(fs.existsSync(work('none.txt')), false);
        });

        it('legacy: dynamic null writes "null"; dynamic numbers are rejected by fs', async function () {
            await load('file-write', { dynamic: true });

            await trigger(helper, 'n1', 'out', {
                file: { action: 'write', path: work('null.txt'), data: null },
            });
            assert.equal(fs.readFileSync(work('null.txt'), 'utf8'), 'null');

            const number = await trigger(helper, 'n1', 'out', {
                file: { action: 'write', path: work('num.txt'), data: 42 },
            });
            assert.equal(number.err.code, 'ERR_INVALID_ARG_TYPE');
            assert.equal(lastStatusText(number), 'Configuration error');
        });

        it('legacy: validation errors carry no code and show "Configuration error"', async function () {
            await load('file-write', { dynamic: true });

            const cases = [
                [{ file: { action: 'write', data: 'x' } }, 'Target path is missing'],
                [{ file: { path: work('x.txt'), data: 'x' } }, 'Action is missing'],
                [{ file: { action: 'write', path: work('x.txt') } }, 'Data to write is undefined'],
                [
                    { file: { action: 'remove', path: work('x.txt'), data: 'x' } },
                    'Unknown action type: remove',
                ],
            ];
            for (const [input, message] of cases) {
                const result = await trigger(helper, 'n1', 'out', input);
                assert.equal(result.err.message, message);
                assert.equal(result.err.code, undefined);
                assert.equal(lastStatusText(result), 'Configuration error');
            }
            assert.equal(fs.existsSync(work('x.txt')), false);
        });

        it('fails with ENOENT for a missing parent unless createDir is set', async function () {
            await load('file-write', { dynamic: true });

            const missing = await trigger(helper, 'n1', 'out', {
                file: { action: 'write', path: work('d', 'x.txt'), data: 'x' },
            });
            assert.equal(missing.err.code, 'ENOENT');
            assert.equal(lastStatusText(missing), 'ENOENT');

            const created = await trigger(helper, 'n1', 'out', {
                file: { action: 'write', path: work('d', 'x.txt'), data: 'x', createDir: true },
            });
            assert.ok(created.msg);
            assert.equal(fs.readFileSync(work('d', 'x.txt'), 'utf8'), 'x');
        });

        it('legacy: keeps significant whitespace in file names', async function () {
            await load('file-write', { dynamic: true });

            await trigger(helper, 'n1', 'out', {
                file: { action: 'write', path: work(' spaced.txt '), data: 's' },
            });

            assert.equal(fs.readFileSync(work(' spaced.txt '), 'utf8'), 's');
        });
    });

    describe('file-transfer', function () {
        it('legacy: delete sets msg.payload to true', async function () {
            await load('file-transfer', { action: 'delete', source: work('a.txt') });

            const result = await trigger(helper, 'n1', 'out', { payload: 'before' });

            assert.equal(fs.existsSync(work('a.txt')), false);
            assert.equal(result.msg.payload, true);
            assert.equal(result.msg.file.destination, null);
            assert.equal(result.msg.file.deleted, undefined);
            assert.equal(lastStatusText(result), 'Deleted a.txt');
        });

        it('legacy: deleting a missing file fails with ENOENT', async function () {
            await load('file-transfer', { action: 'delete', source: work('missing.txt') });

            const result = await trigger(helper, 'n1', 'out', {});

            assert.equal(result.err.code, 'ENOENT');
            assert.equal(lastStatusText(result), 'ENOENT');
        });

        it('legacy: same source and destination forwards the message without metadata', async function () {
            await load('file-transfer', {
                action: 'copy',
                source: work('a.txt'),
                destination: work('.', 'a.txt'),
            });

            const result = await trigger(helper, 'n1', 'out', { file: { keep: 1 } });

            assert.deepEqual(result.msg.file, { keep: 1 });
            assert.equal(lastStatusText(result), 'Source and Destination are identical');
        });

        it('fails with ENOENT when copying a missing source', async function () {
            await load('file-transfer', {
                action: 'copy',
                source: work('missing.txt'),
                destination: work('b.txt'),
            });

            const result = await trigger(helper, 'n1', 'out', {});

            assert.equal(result.err.code, 'ENOENT');
            assert.equal(fs.existsSync(work('b.txt')), false);
        });

        it('falls back to copy and unlink when rename fails with EXDEV', async function () {
            const originalRename = fs.rename;
            fs.rename = (from, to, callback) => {
                const err = new Error('cross-device link not permitted');
                err.code = 'EXDEV';
                process.nextTick(callback, err);
            };
            try {
                await load('file-transfer', {
                    action: 'move',
                    source: work('a.txt'),
                    destination: work('moved.txt'),
                });

                const result = await trigger(helper, 'n1', 'out', {});

                assert.equal(fs.existsSync(work('a.txt')), false);
                assert.equal(fs.readFileSync(work('moved.txt'), 'utf8'), 'alpha');
                assert.equal(lastStatusText(result), 'Moved moved.txt');
            } finally {
                fs.rename = originalRename;
            }
        });

        it('legacy: an unknown action creates the destination directory before failing', async function () {
            await load('file-transfer', {
                action: 'rename',
                source: work('a.txt'),
                destination: work('newdir', 'b.txt'),
                createDir: true,
            });

            const result = await trigger(helper, 'n1', 'out', {});

            assert.equal(result.err.message, 'Unknown action type: rename');
            assert.equal(result.err.code, undefined);
            assert.equal(lastStatusText(result), 'Configuration error');
            assert.equal(fs.existsSync(work('newdir')), true);
        });

        it('legacy: copy/move without a destination fails without a code', async function () {
            await load('file-transfer', { dynamic: true });

            const result = await trigger(helper, 'n1', 'out', {
                file: { action: 'copy', source: work('a.txt') },
            });

            assert.equal(result.err.message, 'Destination path is missing');
            assert.equal(result.err.code, undefined);
        });
    });
});
