<script lang="ts">
  // The in-game menu (SPEC §5.2, §5.5 R17.2, §5.6 rule 5, §5.7 R4.3;
  // design.md §6 score bar, §8 curtain screens). GameScreen owns the menu
  // button and `open`; this component is the panel it opens, plus the Rules
  // sheet the panel can open.
  //
  // Items: Rules, Card style (only when there is more than one), Home, New
  // game (behind a confirm that names the game), Close.
  //
  // Privacy: the panel renders no game state, only the players' names, and
  // those only in the New game confirm. It reads the settings store and
  // the theme catalog; it never reads the game store and never calls the
  // bridge. Nothing here raises, advances or drops a curtain: Home and New
  // game are the host's callbacks, and they are the only things that act.
  // The card style is a look preference in settings, never in the save.
  //
  // Keyboard: while the panel or the Rules sheet is open, one window
  // listener in the CAPTURE phase handles Escape (close it; focus goes back
  // to the menu button) and keeps Tab inside the panel. It stops Escape
  // there, so GameScreen's own Escape (clear a selection or a staged move)
  // never fires under the menu.
  import { settings } from '../stores/settings.svelte';
  import { DEFAULT_THEME_ID, listThemeChoices } from '../theme';
  import RulesSheet from './RulesSheet.svelte';

  interface GameMenuProps {
    open: boolean;
    /** Where the button is: the board's 560 px column, or the screen's edge (curtain and prompt screens). The panel drops from under it. */
    anchor?: 'column' | 'screen';
    names: readonly [string, string];
    /** Close the panel. The host focuses the menu button. */
    onclose: () => void;
    /** Focus the menu button without closing anything (before the Rules sheet opens, so it returns focus there). */
    focusopener: () => void;
    onhome: () => void;
    onnewgame: () => void;
  }

  let { open, anchor = 'column', names, onclose, focusopener, onhome, onnewgame }: GameMenuProps = $props();

  let rulesOpen = $state(false);
  let confirming = $state(false);
  let panel: HTMLDivElement | undefined = $state();

  const themeChoices = $derived(listThemeChoices());
  const selectedTheme = $derived(
    themeChoices.some((choice) => choice.id === settings.themeId) ? settings.themeId : DEFAULT_THEME_ID,
  );

  function close(): void {
    confirming = false;
    onclose();
  }

  function openRules(): void {
    confirming = false;
    focusopener();
    onclose();
    rulesOpen = true;
  }

  function closeRules(): void {
    rulesOpen = false;
  }

  function focusables(): HTMLElement[] {
    if (!panel) return [];
    return [...panel.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')].filter(
      (el) => !(el instanceof HTMLInputElement && el.type === 'radio' && !el.checked),
    );
  }

  // Every close, whoever closes it (Abandon, Home, Close, Escape, a failed
  // New game), drops a half-finished confirm: the next open shows the list,
  // never a live Abandon that one tap would fire on the new game.
  $effect.pre(() => {
    if (!open) confirming = false;
  });

  // Focus the first item whenever the panel (re)draws its list or confirm.
  $effect(() => {
    if (!open || !panel) return;
    void confirming;
    focusables()[0]?.focus();
  });

  $effect(() => {
    if (!open && !rulesOpen) return;
    function onkeydown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.stopPropagation();
        event.stopImmediatePropagation();
        event.preventDefault();
        if (rulesOpen) closeRules();
        else close();
        return;
      }
      if (event.key !== 'Tab' || !open) return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && panel?.contains(active);
      if (!inside || (event.shiftKey && active === first)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', onkeydown, true);
    return () => window.removeEventListener('keydown', onkeydown, true);
  });
</script>

{#if open}
  <!-- A pointer convenience; Escape and the Close item do the same for the keyboard. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="game-menu__backdrop" data-testid="menu-backdrop" onclick={close}></div>
  <div class={['game-menu', anchor === 'screen' && 'game-menu--screen']} data-testid="game-menu" role="dialog" aria-modal="true" aria-label="Menu" bind:this={panel}>
    {#if confirming}
      <div class="game-menu__confirm" role="alertdialog" aria-modal="true" aria-labelledby="game-menu-confirm-text">
        <p id="game-menu-confirm-text" class="game-menu__confirm-text">Abandon {names[0]} vs {names[1]}?</p>
        <p class="game-menu__confirm-note">This game will be lost.</p>
        <div class="game-menu__confirm-actions">
          <button type="button" class="game-menu__item" data-testid="cancel-abandon" onclick={() => (confirming = false)}>
            Cancel
          </button>
          <button type="button" class="game-menu__item game-menu__item--danger" data-testid="confirm-abandon" onclick={onnewgame}>
            Abandon
          </button>
        </div>
      </div>
    {:else}
      <button type="button" class="game-menu__item" data-testid="menu-rules" onclick={openRules}>Rules</button>

      {#if themeChoices.length > 1}
        <fieldset class="game-menu__themes">
          <legend>Card style</legend>
          <div class="game-menu__theme-options">
            {#each themeChoices as choice (choice.id)}
              <label class="game-menu__theme-option" data-testid={`menu-theme-option-${choice.id}`}>
                <input
                  type="radio"
                  name="menu-card-style"
                  value={choice.id}
                  checked={selectedTheme === choice.id}
                  onchange={() => settings.setThemeId(choice.id)}
                />
                <span>{choice.label}</span>
              </label>
            {/each}
          </div>
        </fieldset>
      {/if}

      <button type="button" class="game-menu__item" data-testid="menu-home" onclick={onhome}>Home</button>
      <button type="button" class="game-menu__item" data-testid="menu-new-game" onclick={() => (confirming = true)}>
        New game
      </button>
      <button type="button" class="game-menu__item game-menu__item--quiet" data-testid="menu-close" onclick={close}>
        Close
      </button>
    {/if}
  </div>
{/if}

{#if rulesOpen}
  <!-- Its own stacking layer, so the sheet sits above any board sheet. -->
  <div class="game-menu__rules-layer">
    <RulesSheet onclose={closeRules} />
  </div>
{/if}

<style>
  .game-menu__backdrop {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: rgb(26 20 32 / 0.72);
  }

  /* Drops from the top-right corner, under the menu button, inside the
     560 px column on a desktop; 16 px from each edge on a phone. */
  .game-menu {
    position: fixed;
    z-index: 41;
    top: calc(var(--cu-safe-top, 0px) + var(--cu-space-7, 48px));
    right: max(var(--cu-gutter-sheet, 16px), calc((100vw - var(--cu-board-max, 560px)) / 2 + var(--cu-gutter-board, 10px)));
    display: flex;
    flex-direction: column;
    gap: var(--cu-space-2, 8px);
    box-sizing: border-box;
    width: min(300px, calc(100vw - 2 * var(--cu-gutter-sheet, 16px)));
    max-height: calc(100dvh - var(--cu-safe-top, 0px) - var(--cu-safe-bottom, 0px) - var(--cu-space-7, 48px) - var(--cu-space-4, 16px));
    overflow-y: auto;
    padding: var(--cu-space-3, 12px);
    border: 1px solid var(--cu-ink-line, #4a3d57);
    border-radius: var(--cu-radius-sheet, 18px);
    background: var(--cu-ink-raised, #30263a);
    color: var(--cu-pearl, #eee8f1);
    font-family: var(--cu-font-ui, sans-serif);
    font-size: var(--cu-text-md, 16px);
    box-shadow: 0 12px 32px rgb(0 0 0 / 0.45);
  }

  .game-menu--screen {
    right: max(var(--cu-gutter-sheet, 16px), var(--cu-gutter-board, 10px));
  }

  .game-menu__item {
    box-sizing: border-box;
    width: 100%;
    min-height: var(--cu-tap-min, 44px);
    padding: 0 var(--cu-space-4, 16px);
    border: none;
    border-radius: var(--cu-radius-control, 999px);
    background: var(--cu-ink, #241c2b);
    color: var(--cu-pearl, #eee8f1);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .game-menu__item:focus-visible,
  .game-menu__theme-option:has(input:focus-visible) {
    outline: 2px solid var(--cu-iris, #5ccfc4);
    outline-offset: 2px;
  }

  .game-menu__item--quiet {
    background: transparent;
    color: var(--cu-muted, #b4a8be);
    text-align: center;
  }

  .game-menu__item--danger {
    background: var(--cu-ochre, #f0b54a);
    color: var(--cu-on-accent, #241c2b);
    font-weight: var(--cu-weight-bold, 700);
    text-align: center;
  }

  .game-menu__themes {
    margin: 0;
    padding: var(--cu-space-1, 4px) 0;
    border: none;
    min-width: 0;
  }

  .game-menu__themes legend {
    padding: 0 var(--cu-space-1, 4px);
    margin-bottom: var(--cu-space-1, 4px);
    font-size: var(--cu-text-sm, 14px);
    color: var(--cu-muted, #b4a8be);
  }

  .game-menu__theme-options {
    display: flex;
    gap: var(--cu-space-2, 8px);
  }

  /* The home screen's Card style pills (design.md §2), at menu width. */
  .game-menu__theme-option {
    flex: 1 1 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--cu-space-2, 8px);
    box-sizing: border-box;
    min-height: var(--cu-tap-min, 44px);
    padding: 0 var(--cu-space-2, 8px);
    border: 1px solid var(--cu-ink-line, #4a3d57);
    border-radius: var(--cu-radius-control, 999px);
    background: var(--cu-ink, #241c2b);
    color: var(--cu-pearl, #eee8f1);
    cursor: pointer;
  }

  .game-menu__theme-option:has(input:checked) {
    border-color: var(--cu-ochre, #f0b54a);
    box-shadow: inset 0 0 0 1px var(--cu-ochre, #f0b54a);
  }

  .game-menu__theme-option input {
    accent-color: var(--cu-ochre, #f0b54a);
    margin: 0;
  }

  .game-menu__confirm {
    display: flex;
    flex-direction: column;
    gap: var(--cu-space-2, 8px);
  }

  .game-menu__confirm-text {
    margin: var(--cu-space-1, 4px) var(--cu-space-1, 4px) 0;
    font-weight: var(--cu-weight-bold, 700);
    overflow-wrap: anywhere;
  }

  .game-menu__confirm-note {
    margin: 0 var(--cu-space-1, 4px) var(--cu-space-1, 4px);
    font-size: var(--cu-text-sm, 14px);
    color: var(--cu-muted, #b4a8be);
  }

  .game-menu__confirm-actions {
    display: flex;
    gap: var(--cu-space-2, 8px);
  }

  .game-menu__confirm-actions .game-menu__item {
    text-align: center;
  }

  .game-menu__rules-layer {
    position: relative;
    z-index: 45;
  }
</style>
