'use client'

import * as React from 'react'
import { Label } from '@openbooks/ui'

type NamedControlProps = {
  id?: string
  'aria-labelledby'?: string
  ariaLabelledBy?: string
}

function elementName(type: unknown): string {
  if (typeof type === 'string') return type
  if (typeof type === 'function') {
    const namedType = type as { displayName?: string; name?: string }
    return namedType.displayName || namedType.name || ''
  }
  if (typeof type === 'object' && type !== null && 'displayName' in type) {
    return String((type as { displayName?: string }).displayName ?? '')
  }
  return ''
}

function isLabelElement(type: unknown): boolean {
  return type === 'label' || /(?:^|)Label$/.test(elementName(type))
}

function isControlElement(type: unknown): boolean {
  return ['input', 'textarea', 'select', 'Input', 'Textarea', 'Select', 'SearchSelect'].includes(elementName(type))
}

function isButtonControl(type: unknown): boolean {
  return ['Select', 'SearchSelect'].includes(elementName(type))
}

function isNativeLabelTarget(type: unknown): boolean {
  return ['input', 'textarea', 'select', 'Input', 'Textarea'].includes(elementName(type))
}

export interface FieldProps {
  label: React.ReactNode
  children: React.ReactNode
  className?: string
  labelClassName?: string
  aside?: React.ReactNode
}

export interface FieldControlAssociationsProps {
  controlId: string
  labelId: string
  children: React.ReactNode
}

function associateFieldNodes(node: React.ReactNode, controlId: string, labelId: string, customButtonControl: boolean): React.ReactNode {
  if (Array.isArray(node)) {
    return React.Children.toArray(node).map((child) => associateFieldNodes(child, controlId, labelId, customButtonControl))
  }
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return node

  if (isLabelElement(node.type)) {
    return React.cloneElement(node as React.ReactElement<React.LabelHTMLAttributes<HTMLLabelElement>>, {
      id: labelId,
      ...(customButtonControl ? { htmlFor: undefined } : { htmlFor: controlId }),
    })
  }
  if (isControlElement(node.type)) {
    return React.cloneElement(node as React.ReactElement<NamedControlProps>, {
      id: controlId,
      'aria-labelledby': labelId,
      ...(elementName(node.type) === 'SearchSelect' ? { ariaLabelledBy: labelId } : {}),
    })
  }
  if (node.props.children == null) return node
  return React.cloneElement(node, {
    children: associateFieldNodes(node.props.children, controlId, labelId, customButtonControl),
  })
}

function containsCustomSelect(node: React.ReactNode): boolean {
  if (Array.isArray(node)) return node.some(containsCustomSelect)
  if (!React.isValidElement<{ children?: React.ReactNode }>(node)) return false
  return isButtonControl(node.type) || containsCustomSelect(node.props.children)
}

/** Connects the existing sibling Label/control markup of a shared field renderer. */
export function FieldControlAssociations({ controlId, labelId, children }: FieldControlAssociationsProps) {
  return <>{associateFieldNodes(children, controlId, labelId, containsCustomSelect(children))}</>
}

/** A visible label and its control, associated for native and button-based fields. */
export function Field({ label, children, className, labelClassName, aside }: FieldProps) {
  const controlId = React.useId()
  const labelId = `${controlId}-label`
  const validControl = React.isValidElement(children) && (
    isControlElement(children.type)
  )
  const nativeLabelTarget = React.isValidElement(children) && (
    isNativeLabelTarget(children.type)
  )
  const control = validControl
    ? React.cloneElement(children as React.ReactElement<NamedControlProps>, {
        id: controlId,
        'aria-labelledby': labelId,
        ...(elementName(children.type) === 'SearchSelect' ? { ariaLabelledBy: labelId } : {}),
      })
    : children

  return (
    <div className={className ?? 'space-y-1.5'}>
      <div className={aside ? 'flex items-center justify-between gap-2' : undefined}>
        <Label id={labelId} htmlFor={nativeLabelTarget ? controlId : undefined} className={labelClassName}>{label}</Label>
        {aside}
      </div>
      {control}
    </div>
  )
}
