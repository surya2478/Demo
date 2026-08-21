import { formatToDubaiTime } from './formatToDubaiTime';
import { format } from 'date-fns'
type FieldFileInfo = { name: string; size?: number; type?: string };

export const maskValue = (fieldName: string, value: any): string => {
  if (value === null || value === undefined) return '';
  const name = String(fieldName || '').toLowerCase();
  if (/(password|passwd|secret|token|ssn|session|credit|card|apikey|api_key)/i.test(name)) {
    return '***MASKED***';
  }
  const str = String(value);
  if (str.length > 250) return str.slice(0, 250) + '…';
  return str;
};

export const buildFieldDescription = (
  user: any,
  action: string,
  fieldLabel: string,
  newValue?: any,
  previousValue?: any,
  submodule?: string
): string => {
  const tabName = submodule || 'Application';
  const maskedNew = maskValue(fieldLabel, newValue);
  const maskedPrev = maskValue(fieldLabel, previousValue);

  switch (action) {
    case 'input':
      return `${user} enterend "${maskedNew}" into the  ${fieldLabel} field `; //(${tabName})`;
    case 'change':
      if (previousValue !== undefined) {
        return `${user} changed ${fieldLabel} from "${maskedPrev}" to "${maskedNew}" `; //(${tabName})`;
      }
      return `${user} modified ${fieldLabel} to "${maskedNew}" `; // (${tabName})`;
    case 'file_upload':
      return `${user} uploaded "${maskedNew}" file to ${fieldLabel} field `; //(${tabName})`;
    case 'click':
      return `${user} clicked on ${fieldLabel} `; //(${tabName})`;
    default:
      return ` ${fieldLabel}`; //  ${user.username} performed ${action} on ${fieldLabel} `; //(${tabName})`;
  }
};

export const buildNavigationDescription = (
  fromTab: string | null,
  toTab: string,
  fromLabel?: string | null,
  toLabel?: string
): string => {
  if (!fromTab) {
    return `User accessed ${toLabel ?? toTab}`;
  }
  return `User navigated from ${fromLabel ?? fromTab} to ${toLabel ?? toTab}`;
};

export const buildSessionInfo = (user: any): Record<string, any> | null => {
  if (!user) return null;
  const sessionId = `${String(user.username || 'user').slice(0, 6)}-${Math.random().toString(36).slice(2, 8)}...${Date.now().toString(36).slice(-4)}`;
  return {
    session_id: sessionId,
    status: 'active',
    expires_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
  };
};

export const buildEnvironmentInfo = (): Record<string, any> => {
  return {
    ip:  '',
    user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : 'server',
    source: 'web',
    platform: typeof navigator !== 'undefined' ? navigator.platform : 'server',
    language: typeof navigator !== 'undefined' ? navigator.language : 'en'
  };
};

export const getFieldLabel = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string => {
  const auditName = element.getAttribute('data-audit-name');
  if (auditName) return auditName;
  const ariaLabel = element.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel;
  const placeholder = element.getAttribute('placeholder');
  if (placeholder) return placeholder;
  const id = element.id;
  if (id) {
    const label = document.querySelector(`label[for="${id}"]`);
    if (label && label.textContent) return label.textContent.trim();
  }
  const name = element.getAttribute('name');
  if (name) return name;
  return element.id || 'unnamed-field';
};

export const buildDetailedFieldAudit = (
  user: any,
  action: string,
  fieldLabel: string,
  newValue?: any,
  previousValue?: any,
  submodule?: string,
  description?: string,
  fileInfo?: FieldFileInfo[]
) => {
  const dubai = formatToDubaiTime(new Date().toISOString());
  // const description = "User generated the test cases"//buildFieldDescription(user, action, fieldLabel, newValue, previousValue, submodule);

  const details: Record<string, any> = {
    timestamp: format(new Date().toISOString(), 'MMM dd, yyyy hh:mm:ss a'), //dubai,
    description: description ?? buildFieldDescription(user, action, fieldLabel, newValue, previousValue, submodule),
    session: buildSessionInfo(user),
    environment: buildEnvironmentInfo()
  };

  console.log("details from Helper =============== ",details)
  // Only include context for non-click actions
  if (action !== 'click') {
    details.context = {
      // previous_value: previousValue !== undefined ? maskValue(fieldLabel, previousValue) : null,
      // new_value: newValue !== undefined ? maskValue(fieldLabel, newValue) : null,
      field_length: newValue ? String(newValue).length : 0
    };

    if (action === 'file_upload' && fileInfo && fileInfo.length > 0) {
      details.context.files = fileInfo;
      details.context.file_count = fileInfo.length;
    }
  } else {
    // For clicks you may still want a minimal hint (optional). Keep it out per request.
  }

  return details;
};

export const buildDetailedNavigationAudit = (
  user: any,
  fromTab: string | null,
  toTab: string,
  fromLabel?: string | null,
  toLabel?: string
) => {
  const dubai = formatToDubaiTime(new Date().toISOString());
  const description = buildNavigationDescription(fromTab, toTab, fromLabel, toLabel);

  return {
    timestamp: dubai,
    description,
    context: {
      from_tab: fromTab,
      to_tab: toTab,
      from_label: fromLabel,
      to_label: toLabel,
      transition_type: fromTab ? 'tab_switch' : 'module_entry'
    },
    session: buildSessionInfo(user),
    environment: buildEnvironmentInfo()
  };
};
