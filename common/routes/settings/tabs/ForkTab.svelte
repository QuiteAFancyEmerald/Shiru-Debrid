<script>
  import { onMount } from 'svelte'
  import { ExternalLink } from 'lucide-svelte'
  import { COMMON } from '@/modules/bridge.js'
  import { toast } from '@/modules/lib/toast.js'
  import SettingCard from '@/routes/settings/components/SettingCard.svelte'

  let netGuard = true
  let updatePolicy = 'off'

  onMount(async () => {
    const forkSettings = await COMMON.forkSettingsGet()
    netGuard = forkSettings?.netGuard !== false
    updatePolicy = forkSettings?.updatePolicy === 'fork' ? 'fork' : 'off'
  })

  async function saveNetGuard(value) {
    netGuard = value
    const saved = await COMMON.forkSettingsSet({ netGuard: value })
    netGuard = saved?.netGuard !== false
    toast.success('Fork Setting Saved', {
      description: `Mullvad requirement ${netGuard ? 'enabled' : 'disabled'} — takes effect the next time the app starts.`
    })
  }

  async function saveUpdatePolicy(value) {
    updatePolicy = value === 'fork' ? 'fork' : 'off'
    await COMMON.forkSettingsSet({ updatePolicy })
    toast.success('Fork Setting Saved', {
      description: `Update checks ${updatePolicy === 'fork' ? 'enabled for gabrieljcodes/Shiru (notify + releases link only)' : 'disabled — this build stays frozen'} — takes effect the next time the app starts.`
    })
  }
</script>

<h4 class='mb-10 font-weight-bold'>Fork Settings</h4>
<SettingCard title='About This Build' description='This app is a local fork of Shiru (RockinChaos/Shiru), built from the gabrieljcodes/Shiru branch feat/debrid-and-hayase-v2 — gabrieljcodes&#39; PR #185 &quot;feat(debrid): add extensible debrid support with TorBox provider&quot;. On top of that PR: AllDebrid and Real-Debrid provider support, debrid-only playback (no P2P), disabled session restore, a Mullvad exit-node requirement, and frozen update checks.'>
  <div class='d-flex gap-10'>
    <button
      type='button'
      class='btn btn-sm bg-dark font-size-12 font-weight-semi-bold d-inline-flex align-items-center'
      on:click={() => COMMON.openURI('https://github.com/RockinChaos/Shiru/pull/185')}>
      <ExternalLink size='1.2rem' class='mr-5' />PR #185 (gabrieljcodes debrid)
    </button>
    <button
      type='button'
      class='btn btn-sm bg-dark font-size-12 font-weight-semi-bold d-inline-flex align-items-center'
      on:click={() => COMMON.openURI('https://github.com/gabrieljcodes/Shiru/tree/feat/debrid-and-hayase-v2')}>
      <ExternalLink size='1.2rem' class='mr-5' />Source branch
    </button>
    <button
      type='button'
      class='btn btn-sm bg-dark font-size-12 font-weight-semi-bold d-inline-flex align-items-center'
      on:click={() => COMMON.openURI('https://github.com/RockinChaos/Shiru')}>
      <ExternalLink size='1.2rem' class='mr-5' />Upstream Shiru
    </button>
  </div>
</SettingCard>

<SettingCard title='Require Mullvad Connection' description='Only allow this app to run while your traffic actually exits through Mullvad — a Tailscale exit node (default route via tailscale0) or a Mullvad app tunnel. Otherwise the app refuses to launch, and it closes itself if the tunnel is lost mid-session. Takes effect on app restart.'>
  <div class='custom-switch fit-content'>
    <input type='checkbox' id='fork-net-guard' checked={netGuard} on:change={e => saveNetGuard(e.currentTarget.checked)} />
    <label for='fork-net-guard' aria-label='Require Mullvad Connection'></label>
  </div>
</SettingCard>

<SettingCard title='Update Checks' description='Off keeps this build frozen — it never checks for anything. Enabled, the app checks the gabrieljcodes/Shiru releases feed and shows an update notification linking the release page; it never installs or replaces anything on its own. Takes effect on app restart.'>
  <select class='form-control bg-dark mw-220 w-220 text-truncate' value={updatePolicy} on:change={e => saveUpdatePolicy(e.currentTarget.value)}>
    <option value='off'>Off (Frozen Build)</option>
    <option value='fork'>Fork (gabrieljcodes/Shiru)</option>
  </select>
</SettingCard>

<div class='bg-dark rounded p-15 mt-15 font-size-12 text-muted wm-1200 w-full'>
  Debugging escape hatch once, without changing this setting: launch with
  <code>SHIRU_FORK_NO_GUARD=1</code> as an environment variable.
</div>
