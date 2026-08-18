// src/tests/voice-stt-worker.test.js
//
// PIPER-PRELOAD-v1.1 Section 6 (Change 3) and Section 9.
//
// Run: node --test src/tests/voice-stt-worker.test.js
//
// ── What is under test ────────────────────────────────────────────────────
//
// Change 3 is the same pattern as Changes 1 and 2 applied to the larger cost,
// so most of what matters is the same three properties:
//
//   1. THE FALLBACK. Section 6: transcribe() "falls back to the current
//      per-request spawn on failure". If that is not true, this change is not
//      zero-risk and should not ship.
//   2. THE MEMORY SWITCH. Residency is independently configurable, and the
//      middle state (process warm, model released) is the whole reason it is a
//      separate flag rather than part of the enable flag.
//   3. THE LICENCE BOUNDARY. Now that one module spawns both engines, the
//      separation is a config difference. Asserted in voice-gpl-boundary.test.js
//      and reinforced here from the STT side.
//
// No engine is required. faster-whisper is not installed in CI, and a suite
// that needed it would be skipped -- and a skipped test reports green.

import test           from 'node:test';
import assert         from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');
const VOICE = join(SRC, 'voice');

function read(relative) {
  return readFileSync(join(VOICE, relative), 'utf8');
}

/**
 * Source with every form of comment stripped, for "does not do X" assertions.
 *
 * Python DOCSTRINGS are stripped as well as # comments, and that omission was a
 * real false alarm: voice_stt_worker.py's module docstring explains at length
 * why audio is passed as a path rather than base64 through a pipe, so an
 * assertion that no base64 appears in the file failed on the prose arguing
 * against base64.
 *
 * An assertion that fires on correct code teaches whoever hits it to weaken the
 * assertion, which is how a real check quietly stops checking.
 *
 * @param {string} relative
 * @returns {string}
 */
function code(relative) {
  const TRIPLE_DOUBLE = new RegExp('"'.repeat(3) + '[\\s\\S]*?' + '"'.repeat(3), 'g');
  const TRIPLE_SINGLE = new RegExp("'".repeat(3) + '[\\s\\S]*?' + "'".repeat(3), 'g');
  return read(relative)
    // Python docstrings, both quote styles, before anything else.
    .replace(TRIPLE_DOUBLE, '')
    .replace(TRIPLE_SINGLE, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*#.*$/gm, '');
}

const worker = read('voice_stt_worker.py');
const supervisor = read('stt-worker-supervisor.js');
const shared = read('stdio-worker.js');
const engines = read('voice-engines.js');
const legacy = read('voice_stt.py');

// ===========================================================================
// The fallback contract (Section 6) -- the reason this is zero-risk
// ===========================================================================

test('transcribe tries the worker first and falls through to the spawn', () => {
  const fn = engines.slice(engines.indexOf('export async function transcribe'),
                           engines.indexOf('export async function synthesize'));

  assert.ok(fn.includes('await transcribeViaWorker('),
    'the resident path is attempted');
  assert.ok(fn.includes('if (viaWorker) return viaWorker;'),
    'a null answer falls through');
  assert.ok(fn.indexOf('transcribeViaWorker') < fn.indexOf('run(PYTHON_BIN, args'),
    'the per-request spawn sits BELOW the worker attempt, so falling through reaches it');
  assert.ok(fn.includes("const args = [STT_HELPER, '--transcribe', path, '--model'"),
    'the v12.52.0 spawn survives unchanged as the fallback');
});

test('an unavailable worker falls back; a refusal does not', () => {
  // Retrying a refusal on the spawn reaches the same refusal more slowly, which
  // helps nobody and doubles the model load on a cold cache.
  const call = shared.slice(shared.indexOf('async function call('));
  assert.ok(/if \(refusals\.includes\(err\.code\)\) throw err;/.test(call),
    'only the codes the caller named as refusals propagate');
  assert.ok(call.includes('return null;'), 'everything else means "use the per-request path"');

  // A missing or broken faster-whisper must NOT be a refusal: it can be true of
  // the worker while the per-request spawn -- a different interpreter
  // invocation entirely -- succeeds.
  const supervisor = readFileSync(join(SRC, 'voice', 'stt-worker-supervisor.js'), 'utf8');
  const refusals = /refusals:\s*\(\)\s*=>\s*\[([^\]]*)\]/.exec(supervisor);
  assert.ok(refusals, 'the STT supervisor declares its refusals');
  for (const code of ['stt_failed', 'model_load_failed', 'stt_unavailable']) {
    assert.ok(!refusals[1].includes(code), `${code} must fall back, not fail the turn`);
  }
  // And the ones that genuinely would be refused identically by the spawn.
  for (const code of ['unsupported_model', 'audio_missing']) {
    assert.ok(refusals[1].includes(code), `${code} should not be retried on the spawn`);
  }
});

test('the worker flag reverts transcription to the previous behaviour', () => {
  assert.ok(supervisor.includes("boolEnv('VOICE_STT_WORKER_ENABLED', true)"));
  const fn = supervisor.slice(supervisor.indexOf('export async function transcribeViaWorker'));
  assert.ok(fn.slice(0, 300).includes('if (!sttWorkerEnabled()) return null;'),
    'the flag short-circuits to null, which routes to the spawn');
});

test('the resident path returns the shape the spawn returns', () => {
  // transcribe() must not be able to tell which path produced the result, or
  // every caller downstream becomes a place the two can differ.
  const shaped = supervisor.slice(supervisor.indexOf('return {\n    text:'));
  for (const field of ['text', 'language', 'duration_seconds', 'segments']) {
    assert.ok(shaped.includes(field), `${field} is present`);
    assert.ok(legacy.includes(`"${field}"`), `${field} matches voice_stt.py`);
  }
});

test('the model allowlist is enforced on the resident path too', () => {
  // The tier reaches a loader that fetches by name from a remote registry, so
  // an arbitrary name is an arbitrary fetch. The worker takes its input from a
  // pipe and must not trust it any more than the CLI did.
  assert.ok(worker.includes('ALLOWED_MODELS = ("tiny", "base", "small", "medium", "large-v3")'),
    'the worker carries the same allowlist');
  assert.ok(legacy.includes('ALLOWED_MODELS = ("tiny", "base", "small", "medium", "large-v3")'),
    'and it is identical to voice_stt.py\'s');
  assert.ok(worker.includes('if model_tier not in ALLOWED_MODELS'),
    'and checks it before loading anything');
});

// ===========================================================================
// Residency -- three states, not two (Section 6, Section 10)
// ===========================================================================

test('residency is a separate flag from the worker flag', () => {
  // Section 6: "because holding Whisper plus Piper resident simultaneously may
  // exceed a small instance's memory, STT residency is independently
  // configurable". One flag would force an operator on a tight instance to give
  // up the whole optimisation to control memory.
  assert.ok(supervisor.includes("boolEnv('VOICE_STT_WORKER_RESIDENT', true)"));
  assert.ok(supervisor.includes('export function sttWorkerResident'));
  assert.notEqual(supervisor.indexOf('VOICE_STT_WORKER_ENABLED'),
                  supervisor.indexOf('VOICE_STT_WORKER_RESIDENT'),
                  'they are genuinely two variables');
});

test('residency off releases the model after every request', () => {
  assert.ok(/if not state\.resident:\s*\n\s*state\.unload\(\)/.test(worker),
    'the model is released when residency is off');
  // Inside the finally, so a FAILED transcription does not leave a model
  // resident that the operator explicitly asked us not to hold.
  const transcribe = worker.slice(worker.indexOf('def _transcribe('),
                                  worker.indexOf('def _handle('));
  const finallyAt = transcribe.indexOf('finally:');
  assert.ok(finallyAt !== -1, 'there is a finally block');
  assert.ok(transcribe.indexOf('if not state.resident:') > finallyAt,
    'the release is in the finally, so failure releases too');
});

test('residency off still keeps the interpreter and the import warm', () => {
  // This is the point of the middle state. The import costs a second or more
  // (CTranslate2 pulls in a large native extension) and allocates almost
  // nothing that scales with the model, so releasing it would give back no
  // meaningful memory while paying the cost on every request.
  const ensure = worker.slice(worker.indexOf('def ensure_imported'),
                              worker.indexOf('def load('));
  assert.ok(ensure.includes('if self.whisper_cls is not None:'),
    'the import is cached across requests');
  const unload = worker.slice(worker.indexOf('def unload('),
                              worker.indexOf('def _transcribe('));
  assert.ok(!unload.includes('whisper_cls = None'),
    'unload releases the model, not the import');
});

test('residency off skips the pre-warm rather than loading and discarding', () => {
  assert.ok(supervisor.includes('if (!sttWorkerResident()) return false;'),
    'warming a model we have promised to release is work with no beneficiary');
  assert.ok(worker.includes('residency off; skipping preload'),
    'and the worker declines it independently');
});

test('a tier change releases the old model before building the new', () => {
  // Building first would hold BOTH in memory at the moment of transition, which
  // on a small instance is exactly when it cannot afford to.
  const load = worker.slice(worker.indexOf('    def load(self, model_tier'),
                            worker.indexOf('    def unload('));
  assert.ok(load.includes('self.unload()'), 'the previous model is released');
  assert.ok(load.indexOf('self.unload()') < load.indexOf('self.whisper_cls('),
    'and released BEFORE the new one is constructed');
});

test('unload asks for a collection rather than hoping for one', () => {
  // CTranslate2 holds weights in a native allocation owned by the Python
  // object, so dropping the last reference frees it -- but CPython will not
  // necessarily collect promptly on a process about to sit idle, which is
  // precisely when the memory is wanted back.
  const unload = worker.slice(worker.indexOf('def unload('),
                              worker.indexOf('def _transcribe('));
  assert.ok(unload.includes('gc.collect()'));
  assert.ok(unload.includes('self.model = None'));
});

// ===========================================================================
// Audio handling (voice spec Section 10)
// ===========================================================================

test('audio is passed as a path, never as bytes over the pipe', () => {
  // A minute of speech is megabytes; base64 through a pipe would inflate it by
  // a third and copy it twice for nothing, when the file is already on a
  // filesystem the worker can read.
  assert.ok(supervisor.includes('path: o.path'), 'the supervisor sends a path');
  assert.ok(!/audio_b64|base64/i.test(code('stt-worker-supervisor.js')),
    'no audio is base64-encoded on the STT path');
  assert.ok(!/base64/i.test(code('voice_stt_worker.py')),
    'and the worker never decodes any');
});

test('the caller still owns and deletes the temporary directory', () => {
  const fn = engines.slice(engines.indexOf('export async function transcribe'),
                           engines.indexOf('export async function synthesize'));
  assert.ok(fn.includes('await rm(dir, { recursive: true, force: true })'),
    'the finally still removes the audio');
  assert.ok(fn.indexOf('transcribeViaWorker') < fn.indexOf('} finally {'),
    'the worker call happens inside the try, so cleanup runs after it');
  assert.ok(!/writeFile|createWriteStream/.test(code('voice_stt_worker.py')),
    'the worker writes nothing, so it adds no second place audio can linger');
});

test('the worker never logs audio or the transcript', () => {
  const log = worker.slice(worker.indexOf('def _log('), worker.indexOf('class WorkerState'));
  assert.ok(log.includes('sys.stderr'), 'diagnostics go to stderr');
  // stdout is the protocol channel; a stray print there is a corrupt frame.
  assert.ok(!/print\(/.test(code('voice_stt_worker.py')),
    'nothing prints to stdout outside the protocol writer');
});

// ===========================================================================
// The shared lifecycle (the refactor that made Change 3 cheap)
// ===========================================================================

test('both supervisors use one lifecycle, not two copies', () => {
  assert.ok(supervisor.includes("from './stdio-worker.js'"));
  assert.ok(read('piper-worker-supervisor.js').includes("from './stdio-worker.js'"));
  // Four hundred lines written twice is four hundred lines that drift.
  assert.ok(!/function failPending|function backOff|function armIdleTimer/.test(supervisor),
    'the STT supervisor holds no lifecycle code of its own');
});

test('the Piper supervisor public API is unchanged by the refactor', () => {
  // voice-engines.js calls it, and A5 requires that disabling the worker still
  // gives byte-identical CLI behaviour -- which is only checkable if the
  // interface it is disabled through did not move.
  const piper = read('piper-worker-supervisor.js');
  for (const name of ['workerEnabled', 'prewarmEnabled', 'startWorker',
                      'synthesizeViaWorker', 'prewarm', 'stopWorker',
                      'workerState', 'resetWorkerState']) {
    assert.ok(piper.includes(name), `${name} is still exported`);
  }
});

test('the adapter field survives the refactor at the same health path', () => {
  // A health endpoint is an interface. Moving a field because an internal
  // refactor made it convenient is how a dashboard silently starts reporting
  // "unknown".
  const piper = read('piper-worker-supervisor.js');
  assert.ok(/adapter: \(health\.capabilities && health\.capabilities\.adapter\) \|\| null/.test(piper),
    'tts_worker.adapter is still top-level, as v12.53.0 published it');
});

test('capabilities are merged from any message, not only the ready line', () => {
  // Some facts are not knowable at start: Piper cannot report which synthesis
  // API it bound to before it has a voice loaded.
  assert.ok(shared.includes("if (message.capabilities && 'object' === typeof message.capabilities)"),
    'capabilities update as they become known');
});

test('a wedged worker is restarted rather than waited on again', () => {
  assert.ok(shared.includes("teardown('request timeout')"),
    'a missed deadline means wedged, not slow');
  assert.ok(shared.includes('function failPending'),
    'and in-flight callers are told rather than left waiting');
});

test('a worker that will not start backs off exponentially', () => {
  assert.ok(/Math\.min\(120_000, 2000 \* Math\.pow\(2/.test(shared),
    'bounded exponential backoff');
  assert.ok(shared.includes('state.disabledUntil'),
    'so a missing venv does not spawn a doomed process on every request');
});

// ===========================================================================
// Health and configuration (Section 9, Section 10)
// ===========================================================================

test('the STT worker is reported separately from the TTS worker', () => {
  const routes = readFileSync(join(SRC, 'routes', 'voice.js'), 'utf8');
  assert.ok(routes.includes('stt_worker: sttWorkerHealth()'));
  assert.ok(routes.includes('tts_worker: ttsWorkerState()'));
  // An operator diagnosing memory needs to see WHICH engine is holding a model.
  assert.ok(supervisor.includes('resident: sttWorkerResident()'),
    'health reports whether a model is actually being held');
});

test('every new variable has a safe default', () => {
  assert.ok(supervisor.includes("boolEnv('VOICE_STT_WORKER_ENABLED', true)"));
  assert.ok(supervisor.includes("boolEnv('VOICE_STT_WORKER_RESIDENT', true)"));
  assert.ok(supervisor.includes("intEnv('VOICE_STT_WORKER_IDLE_MS', 180_000"));
  assert.ok(supervisor.includes("intEnv('VOICE_STT_WORKER_START_MS', 60_000"));
});

test('transcription gets a longer ceiling than synthesis', () => {
  // A minute of audio is seconds of work even warm, and a first request also
  // pays the model load. Reusing the synthesis timeout would kill legitimate
  // long transcriptions and look exactly like a wedged worker.
  assert.ok(supervisor.includes("intEnv('VOICE_STT_TIMEOUT', 120_000"),
    'it follows the existing STT ceiling');
  assert.ok(supervisor.includes('VOICE_STT_WORKER_LOAD_GRACE_MS'),
    'plus headroom for a cold model load');
});

test('the start timeout allows for a cold cache download', () => {
  // Constructing a model on a cold cache downloads several hundred megabytes.
  assert.ok(supervisor.includes("intEnv('VOICE_STT_WORKER_START_MS', 60_000, 1000, 900_000)"));
});

test('Whisper is released sooner than Piper by default', () => {
  // It is the larger model, so on an instance holding both it is the one whose
  // idle footprint is worth reclaiming first.
  assert.ok(supervisor.includes("intEnv('VOICE_STT_WORKER_IDLE_MS', 180_000"));
  assert.ok(read('piper-worker-supervisor.js').includes("intEnv('VOICE_TTS_WORKER_IDLE_MS', 300_000"));
});

test('the STT and TTS pre-warms are independent', () => {
  const routes = readFileSync(join(SRC, 'routes', 'voice.js'), 'utf8');
  assert.ok(routes.includes('const warmingStt = prewarmStt();'));
  assert.ok(routes.includes('const warming = prewarmTts();'));
  // A missing voice model must not suppress the Whisper warm, or the reverse.
  assert.ok(engines.includes('export async function prewarmStt'));
  assert.ok(engines.includes('export async function prewarmTts'));
});

test('neither pre-warm blocks the boot', () => {
  const routes = readFileSync(join(SRC, 'routes', 'voice.js'), 'utf8');
  const boot = routes.slice(routes.indexOf('if (voiceEnabled()) {'));
  assert.ok(!/await prewarmStt\(\)|await prewarmTts\(\)/.test(boot),
    'a cold Whisper cache downloads hundreds of megabytes, far past any '
    + 'health-check deadline');
  assert.ok(boot.includes('warmingStt.catch(() => {})'),
    'and an unexpected rejection cannot become an unhandled promise');
});

// ===========================================================================
// Behavioural tests against the real worker implementation
//
// Everything above asserts STRUCTURE by reading source. These run the actual
// Python, with only `WhisperModel` replaced, because the three residency states
// are the substance of Change 3 and a structural assertion cannot tell whether
// the model was really released -- which is the entire point of
// VOICE_STT_WORKER_RESIDENT.
// ===========================================================================

/**
 * Drive voice_stt_worker.py in-process with a stubbed engine.
 *
 * Only `whisper_cls` is replaced. `load`, `unload`, `_handle` and the residency
 * logic are the real ones, so the assertions are about shipped behaviour rather
 * than about the stub.
 *
 * @param {string} body Python that receives `sw`, `WorkerState` and `prime`.
 * @returns {{code: number, stdout: string, stderr: string}}
 */
function runWorkerPython(body) {
  const preamble = `
import importlib.util, os, tempfile, json
spec = importlib.util.spec_from_file_location("sw", ${JSON.stringify(join(SRC, 'voice', 'voice_stt_worker.py'))})
sw = importlib.util.module_from_spec(spec); spec.loader.exec_module(sw)

class Seg:
    def __init__(s,a,b,t): s.start,s.end,s.text=a,b,t
class Info: language="en"; duration=3.25
built={"n":0}
class FakeWhisper:
    def __init__(s,tier,device=None,compute_type=None,download_root=None):
        built["n"]+=1
        assert device=="cpu" and compute_type=="int8"
        s.tier=tier
    def transcribe(s,path,language=None,beam_size=None,vad_filter=None):
        assert beam_size==5 and vad_filter is True
        return iter([Seg(0.0,1.5," Hello "),Seg(1.5,3.25," world. ")]), Info()

def prime(state):
    state.whisper_cls=FakeWhisper; state.version="test"

WorkerState = sw.WorkerState
_tmp=tempfile.NamedTemporaryFile(suffix=".wav",delete=False); _tmp.write(b"RIFF"); _tmp.close()
AUDIO=_tmp.name
def req(i,**k): return dict({"id":i,"op":"transcribe","path":AUDIO,"model":"base","model_dir":""},**k)
`;
  const r = spawnSync('python3', ['-c', preamble + body], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('resident=true holds one model across consecutive requests', () => {
  const r = runWorkerPython(`
st=WorkerState(True); prime(st)
a=sw._handle(st,req(1)); b=sw._handle(st,req(2))
assert a["ok"] and b["ok"]
assert built["n"]==1, "model built %d times, expected 1" % built["n"]
assert st.model is not None
print("OK")
`);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /OK/);
});

test('the worker returns exactly the shape voice_stt.py returns', () => {
  // transcribe() must not be able to tell which path produced the result.
  const r = runWorkerPython(`
st=WorkerState(True); prime(st)
a=sw._handle(st,req(1))
assert a["text"]=="Hello world.", repr(a["text"])
assert a["language"]=="en"
assert a["duration_seconds"]==3.25
assert a["segments"]==[{"start":0.0,"end":1.5,"text":"Hello"},
                       {"start":1.5,"end":3.25,"text":"world."}], a["segments"]
print("OK")
`);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /OK/);
});

test('resident=false releases the model after every request', () => {
  // The tight-memory path Section 6 requires. A structural test cannot see
  // this; only running it can.
  const r = runWorkerPython(`
st=WorkerState(False); prime(st)
sw._handle(st,req(1))
assert st.model is None, "model still resident after request"
sw._handle(st,req(2))
assert st.model is None
assert built["n"]==2, "expected a rebuild per request, got %d" % built["n"]
assert st.whisper_cls is not None, "the import must be held across requests"
print("OK")
`);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /OK/);
});

test('a FAILED transcription also releases the model when not resident', () => {
  // Released in a finally, so an operator who asked us not to hold a model does
  // not end up holding one because transcription happened to throw.
  const r = runWorkerPython(`
class Boom(FakeWhisper):
    def transcribe(s,*a,**k): raise RuntimeError("engine exploded")
st=WorkerState(False); st.whisper_cls=Boom; st.version="t"
a=sw._handle(st,req(1))
assert a["ok"] is False and a["code"]=="stt_failed", a
assert st.model is None, "a failed request left a model resident"
print("OK")
`);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /OK/);
});

test('a tier change never holds two models at once', () => {
  // Building the new model before releasing the old would peak at both, on the
  // small instance that can least afford it.
  const r = runWorkerPython(`
st=WorkerState(True); prime(st)
sw._handle(st,req(1,model="base")); assert st.model_tier=="base"
sw._handle(st,req(2,model="small")); assert st.model_tier=="small"
print("OK")
`);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /OK/);
});

test('bad requests are refused without ending the worker', () => {
  const r = runWorkerPython(`
st=WorkerState(True); prime(st)
for rq,code in [(req(1,model="gpt4"),"unsupported_model"),
                (req(2,path="/nope.wav"),"audio_missing"),
                ({"id":3,"op":"nonsense"},"unknown_op")]:
    a=sw._handle(st,rq)
    assert a["ok"] is False and a["code"]==code, (rq,a)
# still serving afterwards
assert sw._handle(st,req(4))["ok"] is True
print("OK")
`);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /OK/);
});

test('an unknown model tier never reaches the loader', () => {
  // The tier reaches a loader that fetches by name from a remote registry, so
  // an arbitrary name is an arbitrary fetch. Allowlisted, not passed through.
  const r = runWorkerPython(`
st=WorkerState(True); prime(st)
a=sw._handle(st,req(1,model="../../etc/passwd"))
assert a["ok"] is False and a["code"]=="unsupported_model", a
assert built["n"]==0, "the loader was reached with an unvetted name"
print("OK")
`);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /OK/);
});
