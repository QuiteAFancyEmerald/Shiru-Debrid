<script>
  import { Zap } from 'lucide-svelte'

  /** @type {string} */
  export let providerId = ''
  /** @type {string} */
  export let size = '1.6rem'
  let className = ''
  export { className as class }
</script>

{#if providerId === 'torbox'}
  <svg
    class='flex-shrink-0 {className}'
    style='width: {size}; height: {size};'
    viewBox='0 0 100 100'
    fill='none'
    xmlns='http://www.w3.org/2000/svg'
    aria-hidden='true'
  >
    <polygon points='50,0 93.27,24.98 50,50 6.73,24.99' fill='#4AA857' />
    <polygon points='6.73,24.99 50,50 50.01,100 6.73,75.01' fill='#0C4F55' />
    <polygon points='50,50 93.27,24.98 93.27,75.02 50.01,100' fill='#2BB690' />
    <polygon points='73.3,36.5 63.9,42.0 60.2,68.6 72.9,61.5 73.7,84.3 83.0,49.0 70.6,55.5' fill='#FFFFFF' />
  </svg>
{:else if providerId === 'alldebrid'}
  <svg
    class='flex-shrink-0 {className}'
    style='width: {size}; height: {size};'
    viewBox='0 0 100 100'
    fill='none'
    xmlns='http://www.w3.org/2000/svg'
    aria-hidden='true'
  >
    <rect width='100' height='100' rx='24' fill='#2C9BF0' />
    <path d='M50 20 L78 80 L63 80 L55 64 L45 64 L37 80 L22 80 Z M50 30 L56.5 60 L43.5 60 Z' fill='#FFFFFF' fill-rule='evenodd' />
  </svg>
{:else if providerId === 'realdebrid'}
  <svg
    class='flex-shrink-0 {className}'
    style='width: {size}; height: {size};'
    viewBox='0 0 100 100'
    fill='none'
    xmlns='http://www.w3.org/2000/svg'
    aria-hidden='true'
  >
    <rect width='100' height='100' rx='24' fill='#F3124C' />
    <text x='50' y='64' text-anchor='middle' font-family='Arial, Helvetica, sans-serif' font-size='36' font-weight='800' fill='#FFFFFF'>RD</text>
  </svg>
{:else}
  <Zap {size} class={className} />
{/if}
