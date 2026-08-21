import { MenuItem } from '../types'

export const menuItems: MenuItem[] = [
  {
    path: '/dashboard',
    label: 'Dashboard',
    allowedRoles: ['admin', 'manager', 'user']
  },
  {
    path: '/manager-review',
    label: 'Review & Approve',
    allowedRoles: ['admin', 'manager']
  },
  {
    path: '/users',
    label: 'User Management',
    allowedRoles: ['admin']
  },
  {
    path: '/settings',
    label: 'System Settings',
    allowedRoles: ['admin']
  },  
  {
    path: '/sessions',
    label: 'Session Management',
    allowedRoles: ['admin']
  },
  {
    path: '/audit',
    label: 'Audit Logs',
    allowedRoles: ['admin']
  }
]