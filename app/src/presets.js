// Ready-made starting points, grouped by purpose. Each one fills in a full template config.
const { defaultTemplateConfig } = require('./pdf');

const CATEGORIES = ['Education', 'Corporate', 'Events', 'Awards', 'Sports', 'Volunteering'];

const seal = (text, sub = '', extra = {}) => ({ type: 'seal', text, subtext: sub, color: '#b8892b', position: 'bottom-center', size: 84, rotation: 0, opacity: 1, dx: 0, dy: 0, ...extra });

const PRESETS = [
  {
    id: 'course-completion', name: 'Course Completion', category: 'Education',
    description: 'For finishing a course, class or programme.',
    config: { style: 'classic', primaryColor: '#1f3a5f', accentColor: '#b8892b',
      title: 'Certificate of Completion', subtitle: 'This certificate is proudly presented to',
      body: 'for successfully completing the {{course}} programme on {{date}}.' },
  },
  {
    id: 'academic-merit', name: 'Academic Excellence', category: 'Education',
    description: 'Merit certificate for top performers in a subject or term.',
    config: { style: 'elegant', primaryColor: '#5b1a32', accentColor: '#c79a3b',
      title: 'Certificate of Merit', subtitle: 'Awarded with distinction to',
      body: 'in recognition of outstanding academic performance in {{subject}} during the {{year}} academic session.',
      stamps: [seal('MERIT', '{{year}}', { color: '#c79a3b' })] },
  },
  {
    id: 'training', name: 'Training Certification', category: 'Corporate',
    description: 'Professional training with an assessment score.',
    config: { style: 'classic', primaryColor: '#1c1f2a', accentColor: '#8a6d3b',
      title: 'Certificate of Training', subtitle: 'This is to certify that',
      body: 'has successfully completed the {{training}} training and assessment, achieving a score of {{score}}.' },
  },
  {
    id: 'internship', name: 'Internship Completion', category: 'Corporate',
    description: 'Confirms an internship role and duration.',
    config: { style: 'modern', primaryColor: '#0e7490', accentColor: '#f59e0b',
      title: 'Internship Certificate', subtitle: 'This is to certify that',
      body: 'has successfully completed an internship as {{role}} with us from {{start_date}} to {{end_date}}. We wish them every success.' },
  },
  {
    id: 'appreciation', name: 'Certificate of Appreciation', category: 'Corporate',
    description: 'Thank a colleague, partner or guest speaker.',
    config: { style: 'classic', primaryColor: '#0f5132', accentColor: '#c9a227',
      title: 'Certificate of Appreciation', subtitle: 'With sincere gratitude to',
      body: 'for your valuable contribution to {{contribution}}. Your dedication has made a real difference.' },
  },
  {
    id: 'employee-month', name: 'Employee of the Month', category: 'Awards',
    description: 'Monthly staff recognition with a gold seal.',
    config: { style: 'elegant', primaryColor: '#1f3a5f', accentColor: '#c9a227',
      title: 'Employee of the Month', subtitle: 'Proudly awarded to',
      body: 'in recognition of exceptional performance and commitment during {{month}}.',
      stamps: [seal('STAR', 'PERFORMER', { color: '#c9a227' })] },
  },
  {
    id: 'competition-winner', name: 'Competition Winner', category: 'Awards',
    description: 'First, second or third place in a contest.',
    config: { style: 'classic', primaryColor: '#7c2d12', accentColor: '#d4a017',
      title: 'Certificate of Achievement', subtitle: 'This certificate is awarded to',
      body: 'for securing {{position}} place in {{event}} held on {{date}}.',
      stamps: [seal('WINNER', '', { color: '#d4a017' })] },
  },
  {
    id: 'workshop', name: 'Workshop Participation', category: 'Events',
    description: 'For attendees of a workshop or hands-on session.',
    config: { style: 'modern', primaryColor: '#4f46e5', accentColor: '#06b6d4',
      title: 'Certificate of Participation', subtitle: 'This is to certify that',
      body: 'actively participated in the {{event}} workshop held on {{date}}.' },
  },
  {
    id: 'webinar', name: 'Seminar / Webinar Attendance', category: 'Events',
    description: 'Simple attendance certificate for talks and webinars.',
    config: { style: 'minimal', primaryColor: '#0e7490', accentColor: '#22c55e',
      title: 'Certificate of Attendance', subtitle: 'This is to certify that',
      body: 'attended the {{event}} on {{date}}.' },
  },
  {
    id: 'sports', name: 'Sports Achievement', category: 'Sports',
    description: 'Sports day, tournaments and athletic events.',
    config: { style: 'modern', primaryColor: '#9a3412', accentColor: '#facc15',
      title: 'Sports Certificate', subtitle: 'Congratulations to',
      body: 'for securing {{position}} in {{sport}} at the Annual Sports Meet {{year}}.',
      stamps: [seal('CHAMPION', '{{year}}', { color: '#eab308' })] },
  },
  {
    id: 'volunteer', name: 'Volunteer Recognition', category: 'Volunteering',
    description: 'Thank volunteers for their time and service.',
    config: { style: 'minimal', primaryColor: '#9d174d', accentColor: '#f472b6',
      title: 'Certificate of Recognition', subtitle: 'With heartfelt thanks to',
      body: 'for dedicating {{hours}} hours of volunteer service to {{cause}}.' },
  },
  {
    id: 'blank', name: 'Start from scratch', category: null,
    description: 'A plain starting point to design your own.',
    config: { style: 'minimal', primaryColor: '#1c1f2a', accentColor: '#8a8f9c',
      title: 'Certificate', subtitle: 'Presented to', body: '{{reason}}' },
  },
];

function presetList() {
  return PRESETS.map((p) => ({
    ...p,
    config: { ...defaultTemplateConfig(), ...p.config, category: p.category || '' },
  }));
}

module.exports = { CATEGORIES, presetList };
