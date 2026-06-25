const fs = require('fs');
const path = require('path');
const helper = require('node-red-node-test-helper');
const fileWriteNode = require('../src/file-write.js');

helper.init(require.resolve('node-red'));

const DATA_DIR = path.join(__dirname, 'data');
const OUT_DIR = path.join(DATA_DIR, 'out');

function resetOutDir() {
    if (!process.env.KEEP_TEST_FILES) {
        fs.rmSync(OUT_DIR, { recursive: true, force: true });
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });
}

describe('file-write node', function () {
    beforeEach(function (done) {
        resetOutDir();
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(function () {
            if (!process.env.KEEP_TEST_FILES) {
                fs.rmSync(OUT_DIR, { recursive: true, force: true });
            }
            done();
        });
    });

    it('loads with configured properties', function (done) {
        const target = path.join(OUT_DIR, 'loaded.txt');
        const flow = [
            {
                id: 'n1',
                type: 'file-write',
                name: 'write test file',
                dynamic: false,
                action: 'write',
                target,
                targetType: 'str',
                data: 'payload',
                dataType: 'msg',
                createDir: true,
            },
        ];

        helper.load(fileWriteNode, flow, function () {
            const n1 = helper.getNode('n1');
            n1.should.have.property('name', 'write test file');
            n1.should.have.property('action', 'write');
            n1.should.have.property('target', target);
            done();
        });
    });

    it('writes msg.payload to a configured file and emits file metadata', function (done) {
        const target = path.join(OUT_DIR, 'write.txt');
        const flow = [
            {
                id: 'n1',
                type: 'file-write',
                action: 'write',
                target,
                targetType: 'str',
                data: 'payload',
                dataType: 'msg',
                createDir: true,
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(fileWriteNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                fs.readFileSync(target, 'utf8').should.equal('hello\n');
                msg.file.path.should.equal(path.normalize(target));
                msg.file.dir.should.equal(path.dirname(target));
                msg.file.base.should.equal('write.txt');
                msg.file.name.should.equal('write');
                msg.file.ext.should.equal('.txt');
                done();
            });

            n1.receive({ payload: 'hello\n' });
        });
    });

    it('appends msg.payload to an existing configured file', function (done) {
        const target = path.join(OUT_DIR, 'append.txt');
        fs.writeFileSync(target, 'first\n');

        const flow = [
            {
                id: 'n1',
                type: 'file-write',
                action: 'append',
                target,
                targetType: 'str',
                data: 'payload',
                dataType: 'msg',
                createDir: true,
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(fileWriteNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function () {
                fs.readFileSync(target, 'utf8').should.equal('first\nsecond\n');
                done();
            });

            n1.receive({ payload: 'second\n' });
        });
    });

    it('stringifies non-buffer objects before writing', function (done) {
        const target = path.join(OUT_DIR, 'object.json');
        const flow = [
            {
                id: 'n1',
                type: 'file-write',
                action: 'write',
                target,
                targetType: 'str',
                data: 'payload',
                dataType: 'msg',
                createDir: true,
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(fileWriteNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function () {
                fs.readFileSync(target, 'utf8').should.equal('{"ok":true}');
                done();
            });

            n1.receive({ payload: { ok: true } });
        });
    });

    it('writes dynamically from msg.file.path and msg.file.data', function (done) {
        const target = path.join(OUT_DIR, 'dynamic', 'write.txt');
        const flow = [
            { id: 'n1', type: 'file-write', dynamic: true, createDir: true, wires: [['h1']] },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(fileWriteNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                fs.readFileSync(target, 'utf8').should.equal('dynamic\n');
                msg.file.path.should.equal(path.normalize(target));
                msg.file.extra.should.equal('preserved');
                done();
            });

            n1.receive({
                file: {
                    action: 'write',
                    path: target,
                    data: 'dynamic\n',
                    extra: 'preserved',
                },
            });
        });
    });
});
