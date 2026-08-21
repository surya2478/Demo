import React from 'react';
import Header from './Header';
import Sidebar from './Sidebar';

const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    return (
        <div className="flex">
            <Sidebar />
            <div className="flex-1">
                <Header />
                <main className="p-4">
                    {children} 
                </main>
            </div>
        </div>
    );
};

export default Layout;