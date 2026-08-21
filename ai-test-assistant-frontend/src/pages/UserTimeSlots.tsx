import React, { useEffect, useMemo, useState } from 'react'
import userService from '../services/userService'
import type { User } from '../types'
import AppPageHeader from '../components/ui/AppPageHeader'
import SectionCard from '../components/ui/SectionCard'
import StatusBadge from '../components/ui/StatusBadge'
import Button from '../components/shared/Button'

type SavingState = Record<string, boolean>

const UserTimeSlots: React.FC = () => {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState<SavingState>({})

  const loadUsers = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await userService.list()
      setUsers(Array.isArray(response) ? response : [])
    } catch (err: any) {
      const detail = err?.response?.data?.detail ?? err?.message ?? 'Failed to load users'
      setError(typeof detail === 'string' ? detail : 'Failed to load users')
      setUsers([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadUsers()
  }, [])

  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) => String(a.username || '').localeCompare(String(b.username || '')))
  }, [users])

  const updateLocalUserSlot = (username: string, field: 'allowed_time_start' | 'allowed_time_end', value: string) => {
    setUsers((prev) => prev.map((user) => {
      if (user.username !== username) return user
      return {
        ...user,
        [field]: value
      }
    }))
  }

  const handleSaveUserSlot = async (user: User) => {
    const username = user.username
    if (!username) return

    const hasStart = Boolean(user.allowed_time_start)
    const hasEnd = Boolean(user.allowed_time_end)
    if (hasStart !== hasEnd) {
      setError(`Both start and end times are required for ${username}, or leave both empty for 24/7 access.`)
      return
    }

    setSaving((prev) => ({ ...prev, [username]: true }))
    setError(null)
    try {
      await userService.update(username, {
        allowed_time_start: user.allowed_time_start || null,
        allowed_time_end: user.allowed_time_end || null,
      })
    } catch (err: any) {
      const detail = err?.response?.data?.detail ?? err?.message ?? 'Failed to save time slot'
      setError(typeof detail === 'string' ? detail : 'Failed to save time slot')
    } finally {
      setSaving((prev) => ({ ...prev, [username]: false }))
    }
  }

  const handleSet247 = async (user: User) => {
    if (!user.username) return

    const username = user.username
    updateLocalUserSlot(username, 'allowed_time_start', '')
    updateLocalUserSlot(username, 'allowed_time_end', '')

    setSaving((prev) => ({ ...prev, [username]: true }))
    setError(null)
    try {
      await userService.update(username, {
        allowed_time_start: null,
        allowed_time_end: null,
      })
      await loadUsers()
    } catch (err: any) {
      const detail = err?.response?.data?.detail ?? err?.message ?? 'Failed to clear time slot'
      setError(typeof detail === 'string' ? detail : 'Failed to clear time slot')
    } finally {
      setSaving((prev) => ({ ...prev, [username]: false }))
    }
  }

  if (loading) {
    return <div className="text-app-secondary">Loading user time slots...</div>
  }

  return (
    <div className="space-y-6">
      <AppPageHeader
        eyebrow="Administration"
        title="User Login Time Slots"
        description="Configure login windows in Dubai time. Leave both fields empty for 24/7 access. Overnight windows (e.g. 22:00 → 06:00) are supported."
        actions={<Button variant="secondary" onClick={loadUsers}>Refresh</Button>}
      />

      <div className="rounded-3xl border border-amber-100 bg-amber-50 px-5 py-3 text-sm text-amber-800">
        Configure login windows in Dubai time. Leave both fields empty for 24/7 access. Overnight windows are supported (example: 22:00 to 06:00).
      </div>

      {error && (
        <div className="rounded-3xl border border-red-100 bg-red-50 px-5 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <SectionCard
        title="Login windows"
        description={`${sortedUsers.length} ${sortedUsers.length === 1 ? 'user' : 'users'} configured`}
        actions={<StatusBadge tone="brand">Dubai time</StatusBadge>}
        contentClassName="p-0"
      >
        <div className="overflow-x-auto">
        <table className="app-table">
          <thead>
            <tr>
              <th className="text-left">Username</th>
              <th className="text-left">Email</th>
              <th className="text-left">Start</th>
              <th className="text-left">End</th>
              <th className="text-left">Current Access</th>
              <th className="text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {sortedUsers.map((user) => {
              const username = user.username || ''
              const rowSaving = saving[username] === true
              const hasSlot = Boolean(user.allowed_time_start && user.allowed_time_end)
              return (
                <tr key={username || user.email}>
                  <td className="font-medium text-app-primary">{username || '-'}</td>
                  <td className="text-app-secondary">{user.email || '-'}</td>
                  <td>
                    <input
                      type="time"
                      value={user.allowed_time_start || ''}
                      onChange={(e) => updateLocalUserSlot(username, 'allowed_time_start', e.target.value)}
                      className="rounded-xl border border-app bg-app-surface px-2 py-1 text-sm focus:border-app-brand-600 focus:ring-2 focus:ring-app-brand-100"
                      disabled={rowSaving}
                    />
                  </td>
                  <td>
                    <input
                      type="time"
                      value={user.allowed_time_end || ''}
                      onChange={(e) => updateLocalUserSlot(username, 'allowed_time_end', e.target.value)}
                      className="rounded-xl border border-app bg-app-surface px-2 py-1 text-sm focus:border-app-brand-600 focus:ring-2 focus:ring-app-brand-100"
                      disabled={rowSaving}
                    />
                  </td>
                  <td>
                    {hasSlot ? (
                      <StatusBadge tone="warning">{user.allowed_time_start} - {user.allowed_time_end}</StatusBadge>
                    ) : (
                      <StatusBadge tone="success">24/7</StatusBadge>
                    )}
                  </td>
                  <td>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleSaveUserSlot(user)}
                        disabled={rowSaving}
                        className="rounded-2xl bg-app-brand-800 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-app-brand-600 disabled:opacity-60"
                      >
                        {rowSaving ? 'Saving...' : 'Save'}
                      </button>
                      <button
                        onClick={() => handleSet247(user)}
                        disabled={rowSaving}
                        className="rounded-2xl border border-green-200 bg-green-50 px-3 py-1.5 text-xs font-semibold text-green-700 transition hover:bg-green-100 disabled:opacity-60"
                      >
                        24/7
                      </button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      </SectionCard>
    </div>
  )
}

export default UserTimeSlots