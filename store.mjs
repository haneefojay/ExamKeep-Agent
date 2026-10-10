// JSON-file store with atomic writes. One process owns the file.
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const EMPTY = () => ({
  prospects: {},
  log: [],
  criteria: {
    area: 'Ibadan and nearby towns in Oyo State.',
    fit: 'Private secondary schools run by a proprietor, with an ICT lab or one being built, that run their own internal exams. Bigger schools first within a tier.',
    skip: 'Schools already happy with a CBT system, public schools without a proprietor, and primary-only schools.',
  },
  usage: { month: '', usd: 0, searches: 0 },
  job: { running: false, message: '', startedAt: '' },
});

export function openStore(file) {
  let state = EMPTY();
  if (existsSync(file)) state = { ...EMPTY(), ...JSON.parse(readFileSync(file, 'utf8')) };
  else mkdirSync(dirname(file), { recursive: true });
  const save = () => {
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, file);
  };
  const monthNow = () => new Date().toISOString().slice(0, 7);
  const usage = () => {
    if (state.usage.month !== monthNow()) state.usage = { month: monthNow(), usd: 0, searches: 0 };
    return state.usage;
  };
  return {
    get state() { return state; },
    save,
    usage,
    log(school, action, extra = '') {
      state.log.unshift({ at: new Date().toISOString(), school, action, extra });
      state.log = state.log.slice(0, 500);
    },
  };
}
