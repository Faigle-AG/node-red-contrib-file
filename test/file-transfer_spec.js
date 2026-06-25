const fs = require('fs');
const path = require('path');
const helper = require('node-red-node-test-helper');
const fileTransferNode = require('../src/file-transfer.js');
const should = require('should');

helper.init(require.resolve('node-red'));

const DATA_DIR = path.join(__dirname, 'data');
const INPUT_FILE = path.join(DATA_DIR, 'file-in');
const WORK_DIR = path.join(DATA_DIR, 'transfer');
const INPUT_TEXT = 'this is a test file\n';

function resetFiles() {
    if (!process.env.KEEP_TEST_FILES) {
        fs.rmSync(WORK_DIR, { recursive: true, force: true });
    }

    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(INPUT_FILE, INPUT_TEXT);
}

describe('file-transfer node', function () {
    beforeEach(function (done) {
        resetFiles();
        helper.startServer(done);
    });

    afterEach(function (done) {
        helper.unload();
        helper.stopServer(function () {
            if (!process.env.KEEP_TEST_FILES) {
                fs.rmSync(WORK_DIR, { recursive: true, force: true });
            }
            done();
        });
    });

    it('loads with configured properties', function (done) {
        const destination = path.join(WORK_DIR, 'loaded-copy.txt');
        const flow = [
            {
                id: 'n1',
                type: 'file-transfer',
                name: 'copy test file',
                dynamic: false,
                action: 'copy',
                source: INPUT_FILE,
                sourceType: 'str',
                destination,
                destinationType: 'str',
                createDir: true,
            },
        ];

        helper.load(fileTransferNode, flow, function () {
            const n1 = helper.getNode('n1');
            n1.should.have.property('name', 'copy test file');
            n1.should.have.property('action', 'copy');
            n1.should.have.property('source', INPUT_FILE);
            n1.should.have.property('destination', destination);
            done();
        });
    });

    it('copies a configured file and emits destination metadata', function (done) {
        const destination = path.join(WORK_DIR, 'nested', 'copy.txt');
        const flow = [
            {
                id: 'n1',
                type: 'file-transfer',
                action: 'copy',
                source: INPUT_FILE,
                sourceType: 'str',
                destination,
                destinationType: 'str',
                createDir: true,
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(fileTransferNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                fs.readFileSync(destination, 'utf8').should.equal(INPUT_TEXT);
                fs.existsSync(INPUT_FILE).should.equal(true);
                msg.file.action.should.equal('copy');
                msg.file.source.should.equal(path.normalize(INPUT_FILE));
                msg.file.destination.should.equal(path.normalize(destination));
                msg.file.path.should.equal(path.normalize(destination));
                msg.file.base.should.equal('copy.txt');
                msg.file.name.should.equal('copy');
                msg.file.ext.should.equal('.txt');
                done();
            });

            n1.receive({});
        });
    });

    it('moves a configured file', function (done) {
        const source = path.join(WORK_DIR, 'move-source.txt');
        const destination = path.join(WORK_DIR, 'moved.txt');
        fs.writeFileSync(source, INPUT_TEXT);

        const flow = [
            {
                id: 'n1',
                type: 'file-transfer',
                action: 'move',
                source,
                sourceType: 'str',
                destination,
                destinationType: 'str',
                createDir: true,
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(fileTransferNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                fs.existsSync(source).should.equal(false);
                fs.readFileSync(destination, 'utf8').should.equal(INPUT_TEXT);
                msg.file.action.should.equal('move');
                msg.file.path.should.equal(path.normalize(destination));
                done();
            });

            n1.receive({});
        });
    });

    it('deletes a configured file', function (done) {
        const source = path.join(WORK_DIR, 'delete-me.txt');
        fs.writeFileSync(source, INPUT_TEXT);

        const flow = [
            {
                id: 'n1',
                type: 'file-transfer',
                action: 'delete',
                source,
                sourceType: 'str',
                createDir: true,
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(fileTransferNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                fs.existsSync(source).should.equal(false);
                msg.payload.should.equal(true);
                msg.file.action.should.equal('delete');
                msg.file.source.should.equal(path.normalize(source));
                msg.file.path.should.equal(path.normalize(source));
                done();
            });

            n1.receive({});
        });
    });

    it('copies dynamically from msg.file.source to msg.file.destination', function (done) {
        const destination = path.join(WORK_DIR, 'dynamic-copy.txt');
        const flow = [
            { id: 'n1', type: 'file-transfer', dynamic: true, createDir: true, wires: [['h1']] },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(fileTransferNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                fs.readFileSync(destination, 'utf8').should.equal(INPUT_TEXT);
                msg.file.action.should.equal('copy');
                msg.file.extra.should.equal('preserved');
                done();
            });

            n1.receive({
                file: {
                    action: 'copy',
                    source: INPUT_FILE,
                    destination,
                    extra: 'preserved',
                },
            });
        });
    });

    it('does not copy when source and destination are identical', function (done) {
        const flow = [
            {
                id: 'n1',
                type: 'file-transfer',
                action: 'copy',
                source: INPUT_FILE,
                sourceType: 'str',
                destination: INPUT_FILE,
                destinationType: 'str',
                createDir: true,
                wires: [['h1']],
            },
            { id: 'h1', type: 'helper' },
        ];

        helper.load(fileTransferNode, flow, function () {
            const n1 = helper.getNode('n1');
            const h1 = helper.getNode('h1');

            h1.on('input', function (msg) {
                fs.readFileSync(INPUT_FILE, 'utf8').should.equal(INPUT_TEXT);
                should.not.exist(msg.file);
                done();
            });

            n1.receive({});
        });
    });
});
