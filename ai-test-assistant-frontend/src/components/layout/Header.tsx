import React from 'react';
// import Logo from '../../assets/etisalat-logo.svg';

const Header: React.FC = () => {
    return (
        <header className="bg-gray-800 text-white p-4">
            <div className="container mx-auto flex items-center justify-between">
                {/* <div className="flex items-center">
                    <img src={Logo} alt="Etisalat Logo" className="h-8 w-auto" />
                </div> */}
                <nav>
                    <ul className="flex space-x-4">
                        <li><a href="/dashboard" className="hover:underline">Dashboard</a></li>
                        <li><a href="/logout" className="hover:underline">Logout</a></li>
                    </ul>
                </nav>
            </div>
        </header>
    );
};

export default Header;