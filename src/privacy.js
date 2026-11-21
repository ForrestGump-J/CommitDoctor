'use strict';

/** "jane.doe@gmail.com" -> "j***@gmail.com". Used wherever an email could reach a log or a public API. */
const maskEmail = (e) => String(e).replace(/^(.).*(@.*)$/, '$1***$2');

module.exports = { maskEmail };
