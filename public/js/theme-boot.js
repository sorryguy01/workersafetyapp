'use strict';

try {
  const savedTheme = localStorage.getItem('safety-theme');
  if (savedTheme === 'dark' || savedTheme === 'light') document.body.dataset.theme = savedTheme;
} catch (e) { /* storage unavailable */ }
