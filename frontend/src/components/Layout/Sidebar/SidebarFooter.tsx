import { Avatar, Card, Popover, Menu } from 'antd';
import Meta from 'antd/es/card/Meta';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faAngleDown,
  faAngleUp,
  faArrowRightFromBracket,
  faGear,
  faBook,
} from '@fortawesome/free-solid-svg-icons';
import { useNavigate } from 'react-router';

const CURRENT_USER = {
  name: 'Module User',
  email: 'user@example.com',
  imageUrl: undefined as string | undefined,
};

function FooterPopoverContent() {
  const navigate = useNavigate();

  return (
    <Menu
      style={{ width: 200, border: 'none', padding: 0 }}
      selectedKeys={[]}
      items={[
        {
          key: 'profile',
          label: (
            <div style={{ padding: '5px 0', cursor: 'default', lineHeight: 1.2 }}>
              <div style={{ fontSize: 13, fontWeight: 500, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                {CURRENT_USER.name}
              </div>
              <div style={{ fontSize: 11, opacity: 0.65, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                {CURRENT_USER.email}
              </div>
            </div>
          ),
          disabled: true,
        },
        { type: 'divider' },
        {
          key: 'settings',
          icon: <FontAwesomeIcon icon={faGear} />,
          label: 'Settings',
          onClick: () => navigate('/settings'),
        },
        {
          key: 'documentation',
          icon: <FontAwesomeIcon icon={faBook} />,
          label: 'Documentation',
          onClick: () => window.open('https://docs.devic.ai', '_blank'),
        },
        {
          key: 'logout',
          icon: <FontAwesomeIcon icon={faArrowRightFromBracket} />,
          label: 'Log Out',
          onClick: () => console.log('logout'),
        },
      ]}
    />
  );
}

export function SidebarFooter() {
  return (
    <div style={{ width: '100%', cursor: 'pointer' }}>
      <Popover placement="right" arrow={false} content={<FooterPopoverContent />}>
        <Card
          style={{ width: '100%', backgroundColor: 'transparent', padding: 0, borderRadius: 8 }}
          styles={{ body: { padding: 10 } }}
        >
          <Meta
            avatar={
              <Avatar src={CURRENT_USER.imageUrl}>
                {CURRENT_USER.name?.split(' ')?.map((w) => w[0]?.toUpperCase())?.slice(0, 2)?.join('') || ''}
              </Avatar>
            }
            style={{ fontSize: 12 }}
            description={
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                <div style={{ flex: 1, marginRight: 8, overflow: 'hidden' }}>
                  <div style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>{CURRENT_USER.name}</div>
                  <div style={{ textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>{CURRENT_USER.email}</div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                  <FontAwesomeIcon icon={faAngleUp} />
                  <FontAwesomeIcon icon={faAngleDown} />
                </div>
              </div>
            }
          />
        </Card>
      </Popover>
    </div>
  );
}
