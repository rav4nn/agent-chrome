import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    CHROME_ROOT, argbFromHex, choosePort, isRealChromeMain, listProfiles, parsePlist,
    patchPreferences, renderPlist, resolveProfile, slugify,
} from '../bin/agent-chrome.mjs';

const profiles = listProfiles({
    Default: { name: 'Person 1', user_name: 'alice@example.com' },
    'Profile 2': { name: 'Work', user_name: 'bob@example.com' },
    'Profile 3': { name: 'work', user_name: '' },
});
const dirs = (q) => resolveProfile(profiles, q).map((p) => p.dir);

test('resolves a profile by folder, name or email', () => {
    assert.deepEqual(dirs('default'), ['Default']);
    assert.deepEqual(dirs('Profile 2'), ['Profile 2']);
    assert.deepEqual(dirs('person 1'), ['Default']);
    assert.deepEqual(dirs('BOB@example.com'), ['Profile 2']);
});

test('reports ambiguous and unknown profiles', () => {
    assert.deepEqual(dirs('Work'), ['Profile 2', 'Profile 3']);
    assert.deepEqual(dirs('nobody'), []);
    assert.deepEqual(dirs(''), []);
});

test('derives slugs from display names', () => {
    assert.equal(slugify('The Guide International'), 'the-guide-international');
    assert.equal(slugify('  Coffee  Coach! '), 'coffee-coach');
    assert.equal(slugify('rav4nn'), 'rav4nn');
    assert.equal(slugify('日本'), '');
});

test('converts #rrggbb to signed 32-bit ARGB', () => {
    assert.equal(argbFromHex('#D50000'), -2818048);
    assert.equal(argbFromHex('#000000'), -16777216);
    assert.equal(argbFromHex('ffffff'), -1);
    assert.throws(() => argbFromHex('red'));
});

test('patches Preferences and keeps unrelated keys', () => {
    const prefs = {
        browser: { theme: { is_grayscale2: true, user_color: 1 }, window_placement: { top: 5 } },
        sync: { passwords: true, themes: true, keep_everything_synced: true },
        profile: { name: 'Work' },
    };
    const once = patchPreferences(prefs, -2818048);
    assert.deepEqual(once.browser.theme, {
        user_color: -2818048, user_color2: -2818048, color_variant: 3, color_variant2: 3, color_scheme2: 0,
    });
    assert.deepEqual(once.browser.window_placement, { top: 5 });
    assert.deepEqual(once.profile, { name: 'Work' });
    assert.equal(once.sync.passwords, true);
    assert.equal(once.sync.keep_everything_synced, false);
    for (const k of ['themes', 'typed_urls', 'tabs', 'saved_tab_groups', 'extensions', 'apps']) {
        assert.equal(once.sync[k], false, k);
    }
    const snapshot = structuredClone(once);
    assert.deepEqual(patchPreferences(once, -2818048), snapshot);
    assert.deepEqual(patchPreferences({}, 0).browser.theme.user_color, 0);
});

test('plist round trip keeps spaces and &', () => {
    const args = ['/usr/local/bin/node', '/Users/a b/Application Support/x & y/proxy.mjs', '--port', '9411',
        '--user-data-dir', '/Users/a b/R&D <copy>', '--profile-directory', 'Profile 5'];
    const xml = renderPlist({ label: 'io.github.rav4nn.agent-chrome.r-d', args, log: '/tmp/a & b.log' });
    assert.match(xml, /R&amp;D &lt;copy&gt;/);
    assert.deepEqual(parsePlist(xml), {
        label: 'io.github.rav4nn.agent-chrome.r-d',
        args,
        port: 9411,
        userDataDir: '/Users/a b/R&D <copy>',
        profileDir: 'Profile 5',
    });
});

test('chooses the first port not used and not listening', async () => {
    const busy = new Set([9411]);
    const isFree = async (p) => !busy.has(p);
    assert.equal(await choosePort(new Set([9410, 9412]), isFree), 9413);
    assert.equal(await choosePort(new Set(), isFree), 9410);
});

test('spots the real Chrome main process only', () => {
    const bin = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    assert.equal(isRealChromeMain(bin), true);
    assert.equal(isRealChromeMain(`${bin} --user-data-dir=${CHROME_ROOT}/ --flag`), true);
    assert.equal(isRealChromeMain(`${bin} --user-data-dir=/Users/a/Library/Application Support/agent-chrome/profiles/w --remote-debugging-pipe`), false);
    assert.equal(isRealChromeMain(`${bin} --type=renderer`), false);
    assert.equal(isRealChromeMain('/usr/bin/grep Google Chrome'), false);
});
