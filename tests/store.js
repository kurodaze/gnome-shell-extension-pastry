// Store tests for plain gjs, run by `make test` with a throwaway XDG_DATA_HOME.
import GLib from 'gi://GLib';
import System from 'system';

import {Store} from '../build/lib/store.js';

const PNG = GLib.base64_decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');
const loop = new GLib.MainLoop(null, false);
let failed = false;

function check(ok, message) {
    print(ok ? 'ok  ' : 'FAIL', message);
    failed ||= !ok;
}

const sleep = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
    resolve();
    return GLib.SOURCE_REMOVE;
}));

const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'pastry']);
const exists = path => GLib.file_test(`${dir}/${path}`, GLib.FileTest.EXISTS);
const read = path => new TextDecoder().decode(GLib.file_get_contents(`${dir}/${path}`)[1]);
// Image files are named after their SHA-256
const imageName = char => `${char.repeat(64)}.png`;
const text = (value, pinned = false) => ({kind: 'text', text: value, image: '', mime: '', pinned, tag: ''});
const image = (name, mime = 'image/png') => ({kind: 'image', text: '', image: name, mime, pinned: false, tag: ''});

async function testLoadAndImages() {
    GLib.mkdir_with_parents(`${dir}/images`, 0o700);
    GLib.file_set_contents(`${dir}/images/${imageName('a')}`, PNG);
    GLib.file_set_contents(`${dir}/images/${imageName('b')}`, PNG);
    GLib.file_set_contents(`${dir}/history.json`, JSON.stringify({version: 1, entries: [
        {...text('hello', true), tag: 't'},
        image(imageName('a')),
        image(imageName('c')),
        image('../escape.png'),
        image('..'),
        image(imageName('a'), 'text/uri-list'),
        {kind: 'text', text: 'no tag', image: '', mime: '', pinned: false},
        {...text('unknown kind'), kind: 'file'},
    ]}));

    const store = new Store();
    await store.load();
    await sleep(300);
    check(store.entries.length === 2, `loads valid entries only (${store.entries.length})`);
    check(store.entries[0].pinned && store.entries[0].tag === 't', 'keeps pin and tag');
    check(exists(`images/${imageName('a')}`), 'keeps referenced image');
    check(!exists(`images/${imageName('b')}`), 'deletes orphan image');

    const bytes = new GLib.Bytes(PNG);
    const name = store.imageName(bytes, 'image/png');
    await store.writeImage(name, bytes);
    const entry = store.add(image(name));
    const back = await store.readImage(entry);
    check(back.get_size() === PNG.length, 'writes and reads an image');

    store.remove(entry);
    await sleep(800);
    check(!exists(`images/${name}`), 'deletes image of removed entry');
    check(JSON.parse(read('history.json')).entries.length === 2, 'saves history');
    return store;
}

function testTrim(store) {
    for (const value of ['old 1', 'old 2', 'new 1', 'new 2'])
        store.add(text(value));
    store.trim(10, 10);
    const texts = store.entries.map(e => e.text);
    check(texts.join() === 'new 2,new 1,hello', `trims to the text budget, pinned stay (${texts})`);
    store.trim(0, Infinity);
    check(store.entries.length === 1 && store.entries[0].pinned, 'trims to the entry limit');
}

async function testSaveDuringDisable(store) {
    store.add(text('copy A'));
    // The save timer firing, then another copy and a disable before that save is done
    store._save();
    store.add(text('copy B'));
    store.destroy();
    await sleep(1000);
    let saved = [];
    try {
        saved = JSON.parse(read('history.json')).entries.map(e => e.text);
    } catch (e) {
        print('history.json:', e);
    }
    check(saved.includes('copy B'), 'last change survives a disable during a save');
}

async function testUnreadable(contents, message) {
    GLib.file_set_contents(`${dir}/images/${imageName('d')}`, PNG);
    GLib.file_set_contents(`${dir}/history.json`, contents);
    const store = new Store();
    await store.load();
    await sleep(300);
    check(store.entries.length === 0 && !exists('history.json') && read('history.json.bak') === contents,
        `${message}: backed up`);
    check(exists(`images/${imageName('d')}`), `${message}: images kept`);
    store.destroy();
}

async function main() {
    const store = await testLoadAndImages();
    testTrim(store);
    await testSaveDuringDisable(store);
    await testUnreadable('{"version": 1, "entries": [{"kind": "te', 'broken history');
    await testUnreadable(JSON.stringify({version: 99, entries: [text('future')]}), 'unknown version');
    await testUnreadable(JSON.stringify({entries: [text('unversioned')]}), 'missing version');
}

main()
    .catch(e => {
        failed = true;
        print('FAILED:', e, e.stack);
    })
    .finally(() => {
        print(failed ? 'STORE TEST FAILED' : 'STORE TEST PASSED');
        loop.quit();
    });
loop.run();
if (failed)
    System.exit(1);
