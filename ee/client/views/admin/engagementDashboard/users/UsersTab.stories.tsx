import { Margins } from '@rocket.chat/fuselage';
import { Meta, Story } from '@storybook/react';
import React, { ReactElement } from 'react';

import UsersTab from './UsersTab';

export default {
	title: 'Enterprise/Views/Admin/Engagement Dashboard/UsersTab',
	component: UsersTab,
	decorators: [(fn): ReactElement => <Margins children={fn()} all='x24' />],
} as Meta;

export const Default: Story = () => <UsersTab timezone='utc' />;
Default.storyName = 'UsersTab';
