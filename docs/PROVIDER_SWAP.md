# Mock → live Reactor in under ten minutes

The app runs fully on `mock`. This is everything needed to put a real world model behind it.

## 1. Get a key (2 min)

Claim the hackathon credits, then
<https://www.reactor.inc/account/api-keys>. Keys look like `rk_...`.

```bash
cp .env.example .env
# set REACTOR_API_KEY=rk_...
# set SKOPOS_PROVIDER=reactor
```

## 2. What is already done — the Python half

`providers/reactor.py` is implemented, not stubbed. Verified against docs.reactor.inc on
12 September 2026:

| Piece | Value |
|---|---|
| Token endpoint | `POST https://api.reactor.inc/tokens` |
| Auth header | `Reactor-API-Key: rk_...` |
| Body | `{"authorization_details":[{"type":"session","resources":{"models":{"match":["reactor/lingbot-world-2"]}}}]}` |
| Response | `{"jwt": "..."}` |
| Model | `reactor/lingbot-world-2` — image-anchored navigable world, 1664×960 @ 48fps |
| Rate | $0.0070/sec — $25/hr |

`ReactorProvider.prepare()` returns a `RenderHandle(kind="webrtc")` whose `detail` carries
the JWT, model name, seed and idle-kill interval.

## 3. What remains — the browser side (in progress)

`static/index.html` switches to the `<video>` element on `kind === "webrtc"`. Opening the
session, the anchor upload, `start` and the key bindings are being written now and are not
yet verified end to end. The branch needs:

```js
const { LingbotWorld2Model } = await import(handle.detail.sdk);
const model = new LingbotWorld2Model({ videoElement: document.querySelector("#video") });
await model.connect({ jwt: handle.detail.jwt });

const ref = await model.uploadFile(anchorImageFile);   // REQUIRED before start
await model.setImage({ image: ref });
await model.setPrompt({ prompt: handle.prompt });
await model.setSeed({ seed: handle.detail.seed });
await model.start();
```

Then bind keys to `setMoveLongitudinal` / `setMoveLateral` / `setLookHorizontal` /
`setLookVertical`, and on each Skopos step call `setPrompt` with the new
`render.prompt` — it hot-swaps at the next chunk boundary.

## 4. Three things that will bite you

1. **An anchor image is required before `start`.** No image, no generation. Supply a photo
   of the real room — redacted locally first.
2. **The image wins over the prompt.** `handle.detail.promptable_axes` lists the
   perturbations that can be expressed in text (lighting, occlusion, clutter);
   `axes_needing_new_anchor` lists the ones that cannot (moved or removed furniture).
   Render those schematically or supply a second anchor image.
3. **Billing runs from `ready` until terminated, even while idle,** and when a run's chunks
   complete the server starts the next one itself. Honour `detail.idleKillSeconds`, call
   `reset` when idle, and keep one streaming seat. One forgotten tab for four hours is
   ~$100.

## 5. Verify

```bash
SKOPOS_PROVIDER=reactor ./run.sh
```
The header badge should read `provider reactor` and the `<video>` element should replace the
schematic canvas. If the token exchange fails you get a clear `RuntimeError` at startup, not
a silent fallback. Video actually streaming depends on the section 3 browser work landing.
