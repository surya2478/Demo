import React from 'react'
import { theme } from '../../styles/theme'

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode
  className?: string
  variant?: 'primary' | 'secondary' | 'tertiary' | 'danger'
}

const Button: React.FC<ButtonProps> = ({
  children,
  className = '',
  variant = 'primary',
  type = 'button',
  ...props
}) => {
  const variantClass = theme.button[variant] || theme.button.primary

  return (
    <button type={type} className={`${variantClass} ${className}`.trim()} {...props}>
      {children}
    </button>
  )
}

export default Button
