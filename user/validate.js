// user/validate.js
// Lightweight JSON Schema validator for config files.
// Supports the subset used by our schemas: type, properties, required, enum,
// minimum, maximum, minLength, maxLength, pattern, items, additionalProperties.
// Returns { valid: boolean, errors: Array<{ path, message }> }.

export function validate(schema, data) {
  const errors = [];
  checkNode(schema, data, '', errors);
  return { valid: errors.length === 0, errors };
}

function checkNode(schema, data, path, errors) {
  // type
  if (schema.type) {
    const t = schema.type;
    const ok = Array.isArray(t) ? t.some((tt) => matchesType(tt, data)) : matchesType(t, data);
    if (!ok) {
      errors.push({ path: path || '(root)', message: `expected type ${Array.isArray(t) ? t.join(' or ') : t}, got ${typeOf(data)}` });
      return;
    }
  }

  // enum
  if (schema.enum !== undefined && !schema.enum.includes(data)) {
    errors.push({ path: path || '(root)', message: `value must be one of [${schema.enum.join(', ')}]` });
    return;
  }

  // minimum / maximum (numbers)
  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) {
      errors.push({ path, message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && data > schema.maximum) {
      errors.push({ path, message: `must be <= ${schema.maximum}` });
    }
  }

  // minLength / maxLength / pattern (strings)
  if (typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) {
      errors.push({ path, message: `must be at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && data.length > schema.maxLength) {
      errors.push({ path, message: `must be at most ${schema.maxLength} characters` });
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(data)) {
      errors.push({ path, message: `does not match pattern ${schema.pattern}` });
    }
  }

  // object
  if (schema.type === 'object' && typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const props = schema.properties || {};
    const required = schema.required || [];
    for (const req of required) {
      if (!(req in data)) {
        errors.push({ path: path ? `${path}.${req}` : req, message: `required property "${req}" is missing` });
      }
    }
    for (const [key, propSchema] of Object.entries(props)) {
      if (key in data) {
        checkNode(propSchema, data[key], path ? `${path}.${key}` : key, errors);
      }
    }
    if (schema.additionalProperties === false) {
      const known = new Set(Object.keys(props));
      for (const key of Object.keys(data)) {
        if (!known.has(key)) {
          errors.push({ path: path ? `${path}.${key}` : key, message: `additional property "${key}" not allowed` });
        }
      }
    }
  }

  // array
  if (schema.type === 'array' && Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) {
      errors.push({ path, message: `must have at least ${schema.minItems} items` });
    }
    if (schema.maxItems !== undefined && data.length > schema.maxItems) {
      errors.push({ path, message: `must have at most ${schema.maxItems} items` });
    }
    if (schema.items) {
      data.forEach((item, i) => {
        checkNode(schema.items, item, path ? `${path}[${i}]` : `[${i}]`, errors);
      });
    }
  }
}

function matchesType(t, v) {
  if (t === 'integer') return Number.isInteger(v);
  return typeOf(v) === t;
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}
