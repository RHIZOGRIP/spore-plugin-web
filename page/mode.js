try {
  const chosen = window.localStorage.getItem('spore-mode')
  if (chosen === 'light' || chosen === 'dark') document.documentElement.dataset.theme = chosen
} catch (err) {
  console.warn('the colour scheme chosen on this page could not be read', err)
}
