export function initReturnLink(button) {
  let origin = null, fallback = null;

  function clear() {
    origin = fallback = null;
    button.hidden = true;
  }
  button.addEventListener('click', () => {
    const source = typeof origin === 'function' ? origin() : origin;
    const available = source?.isConnected && !source.closest('[inert]') &&
      !source.matches(':disabled') && source.getClientRects().length > 0 &&
      getComputedStyle(source).visibility === 'visible';
    const target = available ? source : fallback;
    clear();
    if (target) {
      target.focus({preventScroll: true});
      target.scrollIntoView({block: 'center'});
    }
  });
  return {
    remember(source, alternative) {
      origin = source;
      fallback = alternative;
      button.hidden = false;
    },
    clear
  };
}
