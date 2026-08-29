import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './TouchKeyboard.module.css'

const LANGUAGE_KEY = 'mml.touch-keyboard-language'
const KEYBOARD_SELECTOR = '[data-touch-keyboard-root]'
const SUPPORTED_INPUT_TYPES = new Set([
  '',
  'email',
  'number',
  'password',
  'search',
  'tel',
  'text',
  'url',
])

const LAYOUTS = {
  en: {
    normal: [
      ['`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='],
      ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']', '\\'],
      ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', "'"],
      ['z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/'],
    ],
    shift: [
      ['~', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+'],
      ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '{', '}', '|'],
      ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ':', '"'],
      ['Z', 'X', 'C', 'V', 'B', 'N', 'M', '<', '>', '?'],
    ],
  },
  th: {
    // Thai Kedmanee: the layout printed on standard Thai PC keyboards.
    normal: [
      ['_', 'ๅ', '/', '-', 'ภ', 'ถ', 'ุ', 'ึ', 'ค', 'ต', 'จ', 'ข', 'ช'],
      ['ๆ', 'ไ', 'ำ', 'พ', 'ะ', 'ั', 'ี', 'ร', 'น', 'ย', 'บ', 'ล', 'ฃ'],
      ['ฟ', 'ห', 'ก', 'ด', 'เ', '้', '่', 'า', 'ส', 'ว', 'ง'],
      ['ผ', 'ป', 'แ', 'อ', 'ิ', 'ื', 'ท', 'ม', 'ใ', 'ฝ'],
    ],
    shift: [
      ['%', '+', '๑', '๒', '๓', '๔', 'ู', '฿', '๕', '๖', '๗', '๘', '๙'],
      ['๐', '"', 'ฎ', 'ฑ', 'ธ', 'ํ', '๊', 'ณ', 'ฯ', 'ญ', 'ฐ', ',', 'ฅ'],
      ['ฤ', 'ฆ', 'ฏ', 'โ', 'ฌ', '็', '๋', 'ษ', 'ศ', 'ซ', '.'],
      ['(', ')', 'ฉ', 'ฮ', 'ฺ', '์', '?', 'ฒ', 'ฬ', 'ฦ'],
    ],
  },
}

const NUMERIC_ROWS = [
  ['7', '8', '9'],
  ['4', '5', '6'],
  ['1', '2', '3'],
  ['-', '0', '.'],
]

function editableInput(target) {
  let candidate = target
  if (!(candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement)) {
    candidate = target instanceof Element ? target.closest('label')?.control : null
  }
  if (!(candidate instanceof HTMLInputElement || candidate instanceof HTMLTextAreaElement)) return null
  if (candidate.disabled || candidate.readOnly || candidate.dataset.touchKeyboard === 'off') return null
  if (candidate instanceof HTMLInputElement && !SUPPORTED_INPUT_TYPES.has(candidate.type)) return null
  return candidate
}

function isNumericInput(element, originalInputMode) {
  if (!(element instanceof HTMLInputElement)) return false
  return element.type === 'number'
    || element.type === 'tel'
    || ['decimal', 'numeric'].includes(originalInputMode ?? element.inputMode)
}

function fieldName(element) {
  if (!element) return 'Text input'
  if (element.type === 'password') return 'Password'
  return element.getAttribute('aria-label')
    || element.labels?.[0]?.textContent?.trim()
    || element.placeholder
    || element.name
    || 'Text input'
}

function setNativeValue(element, value) {
  const prototype = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(element, value)
}

function commitWholeValue(element, value, inputType, data = null) {
  const beforeInput = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    data,
    inputType,
  })
  if (!element.dispatchEvent(beforeInput)) return false
  setNativeValue(element, value)
  element.dispatchEvent(new InputEvent('input', { bubbles: true, data, inputType }))
  requestAnimationFrame(() => element.focus({ preventScroll: true }))
  return true
}

function emitKeyboardEvent(element, type, key) {
  return element.dispatchEvent(new KeyboardEvent(type, {
    key,
    code: key === 'Enter' ? 'Enter' : undefined,
    bubbles: true,
    cancelable: true,
  }))
}

function replaceSelection(element, text, inputType = 'insertText') {
  const value = element.value ?? ''
  const canSelect = typeof element.selectionStart === 'number'
  const start = canSelect ? element.selectionStart : value.length
  const end = canSelect ? element.selectionEnd : value.length
  let inserted = text

  if (element.maxLength >= 0) {
    inserted = inserted.slice(0, Math.max(0, element.maxLength - (value.length - end + start)))
  }

  if (!inserted && inputType !== 'deleteContentBackward') return
  const beforeInput = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    data: inserted || null,
    inputType,
  })
  if (!element.dispatchEvent(beforeInput)) return

  const nextValue = `${value.slice(0, start)}${inserted}${value.slice(end)}`
  const cursor = start + inserted.length
  setNativeValue(element, nextValue)
  element.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    data: inserted || null,
    inputType,
  }))

  requestAnimationFrame(() => {
    element.focus({ preventScroll: true })
    if (typeof element.setSelectionRange === 'function' && element.type !== 'number') {
      element.setSelectionRange(cursor, cursor)
    }
  })
}

function eraseSelection(element) {
  const value = element.value ?? ''
  const canSelect = typeof element.selectionStart === 'number'
  let start = canSelect ? element.selectionStart : value.length
  const end = canSelect ? element.selectionEnd : value.length
  if (start === end && start > 0) start -= 1

  const beforeInput = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    data: null,
    inputType: 'deleteContentBackward',
  })
  if (!element.dispatchEvent(beforeInput)) return

  const nextValue = `${value.slice(0, start)}${value.slice(end)}`
  setNativeValue(element, nextValue)
  element.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    data: null,
    inputType: 'deleteContentBackward',
  }))

  requestAnimationFrame(() => {
    element.focus({ preventScroll: true })
    if (typeof element.setSelectionRange === 'function' && element.type !== 'number') {
      element.setSelectionRange(start, start)
    }
  })
}

function restoreInputMode(element, previousInputMode) {
  if (!element) return
  if (previousInputMode === null) element.removeAttribute('inputmode')
  else element.setAttribute('inputmode', previousInputMode)
}

export default function TouchKeyboard() {
  const [activeElement, setActiveElement] = useState(null)
  const [language, setLanguage] = useState(() => (
    localStorage.getItem(LANGUAGE_KEY) === 'th' ? 'th' : 'en'
  ))
  const [shift, setShift] = useState(false)
  const [numberDraft, setNumberDraft] = useState('')
  const previousInputModeRef = useRef(null)
  const activeElementRef = useRef(null)
  const numberDraftRef = useRef('')
  const keyboardRef = useRef(null)
  const lastTouchRef = useRef(0)

  const close = useCallback(() => {
    restoreInputMode(activeElementRef.current, previousInputModeRef.current)
    activeElementRef.current = null
    previousInputModeRef.current = null
    setActiveElement(null)
    setShift(false)
    setNumberDraft('')
  }, [])

  const openFor = useCallback((element) => {
    if (activeElementRef.current !== element) {
      restoreInputMode(activeElementRef.current, previousInputModeRef.current)
      previousInputModeRef.current = element.getAttribute('inputmode')
      // Prevent the operating-system keyboard from covering the in-app one.
      element.setAttribute('inputmode', 'none')
    }
    activeElementRef.current = element
    numberDraftRef.current = element.type === 'number' ? element.value : ''
    setNumberDraft(numberDraftRef.current)
    setActiveElement(element)
    setShift(false)
  }, [])

  useEffect(() => {
    function onPointerDown(event) {
      if (event.target.closest?.(KEYBOARD_SELECTOR)) return
      const element = editableInput(event.target)
      if (element && (event.pointerType === 'touch' || event.pointerType === 'pen')) {
        lastTouchRef.current = performance.now()
        openFor(element)
        return
      }
      if (event.pointerType === 'touch' || event.pointerType === 'pen') {
        lastTouchRef.current = performance.now()
      }
      if (activeElementRef.current) close()
    }

    function onFocusIn(event) {
      const element = editableInput(event.target)
      if (element && performance.now() - lastTouchRef.current < 1000) openFor(element)
    }

    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('focusin', onFocusIn, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('focusin', onFocusIn, true)
    }
  }, [close, openFor])

  useEffect(() => {
    if (!activeElement) return undefined
    document.documentElement.classList.add('touch-keyboard-open')

    const revealInput = window.setTimeout(() => {
      const keyboardTop = keyboardRef.current?.getBoundingClientRect().top ?? window.innerHeight
      const inputRect = activeElement.getBoundingClientRect()
      if (inputRect.bottom > keyboardTop - 16 || inputRect.top < 8) {
        activeElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }
    }, 80)

    return () => {
      window.clearTimeout(revealInput)
      document.documentElement.classList.remove('touch-keyboard-open')
    }
  }, [activeElement])

  useEffect(() => () => {
    restoreInputMode(activeElementRef.current, previousInputModeRef.current)
    document.documentElement.classList.remove('touch-keyboard-open')
  }, [])

  const changeLanguage = useCallback(() => {
    setLanguage((current) => {
      const next = current === 'en' ? 'th' : 'en'
      localStorage.setItem(LANGUAGE_KEY, next)
      return next
    })
    setShift(false)
  }, [])

  const press = useCallback((key) => {
    const element = activeElementRef.current
    if (!element?.isConnected) {
      close()
      return
    }

    if (key === 'backspace') {
      if (element.type === 'number') {
        if (emitKeyboardEvent(element, 'keydown', 'Backspace')) {
          const next = numberDraftRef.current.slice(0, -1)
          numberDraftRef.current = next
          setNumberDraft(next)
          if (next === '' || /^-?(?:\d+|\d*\.\d+)$/.test(next)) {
            commitWholeValue(element, next, 'deleteContentBackward')
          }
        }
      } else if (emitKeyboardEvent(element, 'keydown', 'Backspace')) {
        eraseSelection(element)
      }
      emitKeyboardEvent(element, 'keyup', 'Backspace')
      return
    }
    if (key === 'enter') {
      const proceed = emitKeyboardEvent(element, 'keydown', 'Enter')
      if (proceed && element instanceof HTMLTextAreaElement) {
        replaceSelection(element, '\n', 'insertLineBreak')
      } else if (proceed) {
        if (element.type === 'number') {
          const completeDraft = numberDraftRef.current.endsWith('.')
            ? numberDraftRef.current.slice(0, -1)
            : numberDraftRef.current
          const safeDraft = ['-', '-.'].includes(completeDraft) ? '' : completeDraft
          if (safeDraft !== element.value) {
            numberDraftRef.current = safeDraft
            setNumberDraft(safeDraft)
            commitWholeValue(element, safeDraft, 'insertText')
          }
        }
        element.form?.requestSubmit()
      }
      emitKeyboardEvent(element, 'keyup', 'Enter')
      if (!(element instanceof HTMLTextAreaElement)) close()
      return
    }
    if (key === 'left' || key === 'right') {
      if (typeof element.selectionStart !== 'number' || element.type === 'number') return
      const next = key === 'left'
        ? Math.max(0, element.selectionStart - 1)
        : Math.min(element.value.length, element.selectionEnd + 1)
      element.setSelectionRange(next, next)
      element.focus({ preventScroll: true })
      return
    }
    if (element.type === 'number') {
      let next = numberDraftRef.current
      if (key === '-') next = next.startsWith('-') ? next.slice(1) : `-${next}`
      else if (key === '.') {
        if (next.includes('.')) return
        next = `${next || '0'}.`
      } else next += key

      numberDraftRef.current = next
      setNumberDraft(next)
      if (/^-?(?:\d+|\d*\.\d+)$/.test(next)) commitWholeValue(element, next, 'insertText', key)
      return
    }
    replaceSelection(element, key)
    if (shift) setShift(false)
  }, [close, shift])

  if (!activeElement) return null

  const numeric = isNumericInput(activeElement, previousInputModeRef.current)
  const rows = numeric ? NUMERIC_ROWS : LAYOUTS[language][shift ? 'shift' : 'normal']

  return (
    <section
      ref={keyboardRef}
      className={`${styles.keyboard} ${numeric ? styles.numeric : ''}`}
      data-touch-keyboard-root
      role="region"
      aria-label="On-screen keyboard"
      onPointerDown={(event) => event.preventDefault()}
    >
      <div className={styles.statusRail}>
        <div className={styles.fieldStatus}>
          <span className={styles.statusLight} aria-hidden="true" />
          <span className={styles.fieldLabel}>{fieldName(activeElement)}</span>
          {activeElement.type === 'number' && <output className={styles.draftValue}>{numberDraft || '—'}</output>}
          <span className={styles.modeLabel}>{numeric ? 'NUM' : language.toUpperCase()}</span>
        </div>
        <div className={styles.headerActions}>
          {!numeric && (
            <button type="button" className={styles.languageButton} onClick={changeLanguage}>
              <span className={language === 'en' ? styles.languageActive : ''}>EN</span>
              <span aria-hidden="true">/</span>
              <span className={language === 'th' ? styles.languageActive : ''}>ไทย</span>
            </button>
          )}
          <button type="button" className={styles.closeButton} onClick={close} aria-label="Close keyboard">
            Close
          </button>
        </div>
      </div>

      <div className={styles.keyDeck} lang={language === 'th' ? 'th' : 'en'}>
        <div className={styles.characterRows}>
          {rows.map((row, rowIndex) => (
            <div className={styles.keyRow} key={`${language}-${rowIndex}`}>
              {row.map((key) => (
                <button type="button" className={styles.key} key={key} onClick={() => press(key)}>
                  {key}
                </button>
              ))}
              {rowIndex === 0 && (
                <button
                  type="button"
                  className={`${styles.key} ${styles.backspace}`}
                  onClick={() => press('backspace')}
                  aria-label="Backspace"
                >
                  ⌫
                </button>
              )}
            </div>
          ))}
        </div>

        <div className={styles.utilityRow}>
          {!numeric && (
            <button
              type="button"
              className={`${styles.key} ${styles.utilityKey} ${shift ? styles.keyActive : ''}`}
              onClick={() => setShift((current) => !current)}
              aria-pressed={shift}
            >
              ⇧ Shift
            </button>
          )}
          <button type="button" className={`${styles.key} ${styles.arrowKey}`} onClick={() => press('left')} aria-label="Move cursor left">
            ←
          </button>
          <button type="button" className={`${styles.key} ${styles.spaceKey}`} onClick={() => press(' ')} aria-label="Space">
            <span>Space</span>
          </button>
          <button type="button" className={`${styles.key} ${styles.arrowKey}`} onClick={() => press('right')} aria-label="Move cursor right">
            →
          </button>
          <button type="button" className={`${styles.key} ${styles.enterKey}`} onClick={() => press('enter')}>
            {activeElement instanceof HTMLTextAreaElement ? 'New line' : 'Enter'} ↵
          </button>
        </div>
      </div>
    </section>
  )
}
