import React from 'react';
import { Link } from 'react-router-dom';

const Sidebar: React.FC = () => {
    return (
        <div className="bg-gray-800 text-white w-64 h-full">
            <h2 className="text-xl font-bold p-4">Admin Dashboard</h2>
            <nav className="mt-5">
                <ul>
                    <li className="p-2 hover:bg-gray-700">
                        <Link to="/dashboard">Dashboard</Link>
                    </li>
                    <li className="p-2 hover:bg-gray-700">
                        <Link to="/login">Login</Link>
                    </li>
                    {/* Add more navigation links as needed */}
                </ul>
            </nav>
        </div>
    );
};

export default Sidebar;